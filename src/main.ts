import 'dotenv/config';
import Redis from 'ioredis';
import Fastify from 'fastify';
import FastifyCors from '@fastify/cors';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

// Import Routes
import books from './routes/books';
import anime from './routes/anime';
import manga from './routes/manga';
import comics from './routes/comics';
import lightnovels from './routes/light-novels';
import movies from './routes/movies';
import meta from './routes/meta';
import news from './routes/news';
import Utils from './utils';

// --- CONFIGURATION ---
const PORT = Number(process.env.PORT) || 3000;
const REDIS_TTL = Number(process.env.REDIS_TTL) || 3600;

// --- REDIS SETUP (Optional) ---
let redis: Redis | undefined;
if (process.env.REDIS_HOST) {
    redis = new Redis({
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT),
        password: process.env.REDIS_PASSWORD,
    });
    redis.on('error', (err) => console.error(chalk.red('Redis Error:'), err));
    redis.on('connect', () => console.log(chalk.green('Redis Connected!')));
} else {
    console.log(chalk.yellow('Redis not configured. Caching disabled.'));
}
export { redis };

export const tmdbApi = process.env.TMDB_KEY;

// --- FASTIFY SETUP ---
const fastify = Fastify({
    maxParamLength: 1000,
    logger: true,
});

(async () => {
    try {
        // 1. Register CORS (Allows your frontend to talk to this API)
        await fastify.register(FastifyCors, {
            origin: '*',
            methods: ['GET'],
        });

        // 2. Register Routes
        await fastify.register(books, { prefix: '/books' });
        await fastify.register(anime, { prefix: '/anime' });
        await fastify.register(manga, { prefix: '/manga' });
        await fastify.register(comics, { prefix: '/comics' });
        await fastify.register(lightnovels, { prefix: '/light-novels' });
        await fastify.register(movies, { prefix: '/movies' });
        await fastify.register(meta, { prefix: '/meta' });
        await fastify.register(news, { prefix: '/news' });
        await fastify.register(Utils, { prefix: '/utils' });

        // 3. Base Route (Health Check)
        fastify.get('/', (_, reply) => {
            reply.status(200).send({
                message: 'Welcome to Nika API! 🚀',
                status: 'Active',
            });
        });

        fastify.get('*', (_, reply) => {
            reply.status(404).send({ message: 'Page not found' });
        });

        // 4. Start Server
        // 0.0.0.0 is CRITICAL for Render/Public access
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        console.log(chalk.green(`🚀 Server is running on port ${PORT}`));

    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
})();

// Export for Serverless (Optional, keeps Vercel compatibility)
export default async function handler(req: any, res: any) {
    await fastify.ready();
    fastify.server.emit('request', req, res);
}