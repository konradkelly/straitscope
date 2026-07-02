/**
 * api.js — Fastify REST API (spec §7). Read-only, no auth in v1.
 *
 * Every route is backed by a tiny in-process TTL cache (per spec's "JSON
 * (cached)" architecture note) — fine for a single-instance deployment;
 * would need to move to a shared cache if this ever scales past one process.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { parse as parseYaml } from 'yaml';
import { pool, shutdown } from './db.js';

const PORT = Number(process.env.PORT ?? 8080);
const INCIDENTS_PATH = process.env.INCIDENTS_PATH ?? new URL('../data/incidents.yaml', import.meta.url);

function ttlCache(ttlMs) {
  const store = new Map();
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (Date.now() > hit.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value) {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
  };
}

const liveCache = ttlCache(30_000);
const dailyCache = ttlCache(5 * 60_000);
const headlineCache = ttlCache(5 * 60_000);
const incidentsCache = ttlCache(5 * 60_000);
const trackCache = ttlCache(60_000);

export async function buildServer() {
  const fastify = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  await fastify.register(cors, { origin: true });

  // Live vessel positions for the map — latest report per vessel seen in
  // the last 2 hours.
  fastify.get('/api/v1/live', async (req, reply) => {
    const hit = liveCache.get('all');
    if (hit) {
      reply.header('Cache-Control', 'public, max-age=30');
      return hit;
    }
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (p.mmsi)
        p.mmsi, p.time, p.lat, p.lon, p.sog, p.cog, p.heading, p.corridor,
        v.name, v.ship_type_class
      FROM vessel_positions p
      LEFT JOIN vessels v ON v.mmsi = p.mmsi
      WHERE p.time > now() - interval '2 hours'
      ORDER BY p.mmsi, p.time DESC
    `);
    liveCache.set('all', rows);
    reply.header('Cache-Control', 'public, max-age=30');
    return rows;
  });

  // Daily transit counts by direction and route.
  fastify.get('/api/v1/stats/daily', async (req, reply) => {
    const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 365);
    const key = String(days);
    const hit = dailyCache.get(key);
    if (hit) {
      reply.header('Cache-Control', 'public, max-age=300');
      return hit;
    }
    const { rows } = await pool.query(
      `SELECT day, direction, route, transit_count, distinct_vessels
       FROM daily_stats
       WHERE day >= current_date - $1::int
       ORDER BY day`,
      [days]
    );
    dailyCache.set(key, rows);
    reply.header('Cache-Control', 'public, max-age=300');
    return rows;
  });

  // Headline stats: today's transits, 7-day avg, route split %, dark count.
  fastify.get('/api/v1/stats/headline', async (req, reply) => {
    const hit = headlineCache.get('all');
    if (hit) {
      reply.header('Cache-Control', 'public, max-age=300');
      return hit;
    }
    const [todayRes, weekRes, splitRes, darkRes] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n FROM transits WHERE exited_at::date = current_date`),
      pool.query(`SELECT count(*)::int AS n FROM transits WHERE exited_at >= now() - interval '7 days'`),
      pool.query(
        `SELECT route, count(*)::int AS n FROM transits
         WHERE exited_at >= now() - interval '7 days' GROUP BY route`
      ),
      pool.query(
        `SELECT count(DISTINCT mmsi)::int AS n FROM dark_events WHERE detected_at >= now() - interval '24 hours'`
      ),
    ]);

    const weekTotal = weekRes.rows[0].n;
    const splitCounts = Object.fromEntries(splitRes.rows.map((r) => [r.route, r.n]));
    const pct = (n) => (weekTotal > 0 ? Math.round((n / weekTotal) * 1000) / 10 : 0);

    const data = {
      today_transits: todayRes.rows[0].n,
      seven_day_avg: Math.round((weekTotal / 7) * 10) / 10,
      route_split_pct: {
        northern: pct(splitCounts.northern ?? 0),
        southern: pct(splitCounts.southern ?? 0),
        mixed: pct(splitCounts.mixed ?? 0),
      },
      dark_vessel_count_24h: darkRes.rows[0].n,
    };
    headlineCache.set('all', data);
    reply.header('Cache-Control', 'public, max-age=300');
    return data;
  });

  // Curated incident timeline (data/incidents.yaml — PR = publish).
  fastify.get('/api/v1/incidents', async (req, reply) => {
    const hit = incidentsCache.get('all');
    if (hit) {
      reply.header('Cache-Control', 'public, max-age=300');
      return hit;
    }
    const raw = await readFile(INCIDENTS_PATH, 'utf8');
    const parsed = parseYaml(raw) ?? [];
    const sorted = [...parsed].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    incidentsCache.set('all', sorted);
    reply.header('Cache-Control', 'public, max-age=300');
    return sorted;
  });

  // Recent track for a single vessel (map click-through).
  fastify.get('/api/v1/vessel/:mmsi/track', async (req, reply) => {
    const mmsi = Number(req.params.mmsi);
    if (!Number.isFinite(mmsi)) {
      reply.code(400);
      return { error: 'invalid mmsi' };
    }
    const hours = Math.min(Math.max(Number(req.query.hours ?? 24) || 24, 1), 168);
    const key = `${mmsi}:${hours}`;
    const hit = trackCache.get(key);
    if (hit) {
      reply.header('Cache-Control', 'public, max-age=60');
      return hit;
    }
    const { rows } = await pool.query(
      `SELECT time, lat, lon, sog, cog, corridor FROM vessel_positions
       WHERE mmsi = $1 AND time > now() - ($2 || ' hours')::interval
       ORDER BY time`,
      [mmsi, hours]
    );
    trackCache.set(key, rows);
    reply.header('Cache-Control', 'public, max-age=60');
    return rows;
  });

  // Liveness: db reachable + AIS feed not stalled (spec §9 monitoring).
  // Derived from the newest stored position rather than ingest's local
  // heartbeat file, since api and ingest are separate containers/processes
  // that don't share a filesystem.
  fastify.get('/healthz', async (req, reply) => {
    try {
      const { rows } = await pool.query(
        `SELECT extract(epoch FROM (now() - max(time)))::float AS lag_s FROM vessel_positions`
      );
      const lagS = rows[0].lag_s;
      const healthy = lagS != null && lagS < 300; // 5 min per spec §9
      reply.code(healthy ? 200 : 503);
      return { db: 'ok', last_message_age_s: lagS, healthy };
    } catch (err) {
      reply.code(503);
      return { db: 'error', error: err.message, healthy: false };
    }
  });

  return fastify;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const fastify = await buildServer();
  await fastify.listen({ port: PORT, host: '0.0.0.0' });

  process.on('SIGTERM', async () => {
    fastify.log.info('SIGTERM — shutting down');
    await fastify.close();
    await shutdown();
    process.exit(0);
  });
}
