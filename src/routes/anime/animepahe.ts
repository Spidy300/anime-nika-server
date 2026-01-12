import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import chalk from 'chalk';
import * as cheerio from 'cheerio';
import { ANIME } from '@consumet/extensions';

// --- ROBUST ANIMEPAHE API SCRAPER (Manual) ---
class CustomPahe {
    baseUrl = "https://animepahe.ru";
    // We use a specific User-Agent to look like a real browser
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://animepahe.ru/'
    };

    async search(query: string) {
        try {
            console.log(chalk.gray(`   -> Searching Pahe API for: ${query}`));
            const res = await fetch(`${this.baseUrl}/api?m=search&q=${encodeURIComponent(query)}`, { headers: this.headers });
            const data: any = await res.json();
            
            if (!data.data || data.data.length === 0) return { results: [] };

            return {
                results: data.data.map((item: any) => ({
                    id: item.session, // This is the unique anime ID for Pahe
                    title: item.title,
                    image: item.poster,
                    type: item.type,
                    status: item.status
                }))
            };
        } catch (e) {
            console.error("Pahe Search Error:", e);
            return { results: [] };
        }
    }

    async fetchAnimeInfo(id: string) {
        try {
            // Get episodes from Pahe API (Page 1)
            const res = await fetch(`${this.baseUrl}/api?m=release&id=${id}&sort=episode_asc&page=1`, { headers: this.headers });
            const data: any = await res.json();
            
            if (!data.data) throw new Error("No data returned from Pahe Info API");

            const episodes = data.data.map((ep: any) => ({
                id: `${id}*${ep.session}`, // Combine AnimeID and EpisodeID using '*'
                number: ep.episode,
                title: `Episode ${ep.episode}`
            }));

            return {
                id,
                title: "AnimePahe Results",
                episodes: episodes
            };
        } catch (e) {
            throw new Error("Pahe Info failed");
        }
    }

    async fetchEpisodeSources(episodeId: string) {
        try {
            const [animeSession, epSession] = episodeId.split("*");
            // Step 1: Get the 'kwik' link from the play page
            const res = await fetch(`${this.baseUrl}/play/${animeSession}/${epSession}`, { headers: this.headers });
            const html = await res.text();
            
            // Regex to find the kwik.cx link
            const kwikLink = html.match(/https:\/\/kwik\.cx\/e\/[a-zA-Z0-9]+/)?.[0];
            if (!kwikLink) throw new Error("Could not extract Kwik video link");

            return {
                sources: [{
                    url: kwikLink, // Note: You'll need to handle the Kwik player in ArtPlayer
                    quality: '720p',
                    isM3U8: false
                }],
                headers: { 'Referer': 'https://kwik.cx/' }
            };
        } catch (e: any) {
            throw new Error("Pahe Watch failed: " + e.message);
        }
    }
}

// --- GOGO SCRAPER (Blind Trust Fallback) ---
class CustomGogo {
    async search(query: string) {
        const guessId = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return { results: [{ id: guessId, title: query, image: "", releaseDate: "Guessed" }] };
    }
    // (Other Gogo methods removed for stability as they are currently blocked on Render)
}

const customPahe = new CustomPahe();
const customGogo = new CustomGogo();

const routes = async (fastify: FastifyInstance, options: any) => {
    const safeRun = async (providerName: string, fn: () => Promise<any>, reply: any) => {
        try {
            console.log(chalk.blue(`[${providerName}] Running...`));
            const res = await fn();
            console.log(chalk.green(`   -> Success`));
            return reply.send(res);
        } catch (e: any) {
            console.error(chalk.red(`   -> Error:`), e.message);
            return reply.status(200).send({ error: e.message, results: [] });
        }
    };

    // --- UPDATED ROUTES ---

    // 1. AnimePahe (Priority)
    fastify.get('/:query', (req: any, res) => safeRun('Pahe', () => customPahe.search(req.params.query), res));
    fastify.get('/info/:id', (req: any, res) => safeRun('Pahe', () => customPahe.fetchAnimeInfo(req.params.id), res));
    fastify.get('/watch/:episodeId', (req: any, res) => {
        const id = req.params.episodeId.replace(/~/g, "*"); // Fix URL formatting
        return safeRun('Pahe', () => customPahe.fetchEpisodeSources(id), res);
    });

    // 2. Gogo (Secondary)
    fastify.get('/gogo/search/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));

    // 3. Hianime (Consumet Extension)
    fastify.get('/hianime/search/:query', (req: any, res) => safeRun('Hianime', () => new ANIME.Hianime().search(req.params.query), res));
    fastify.get('/hianime/info/:id', (req: any, res) => safeRun('Hianime', () => new ANIME.Hianime().fetchAnimeInfo(req.params.id), res));
    fastify.get('/hianime/watch/:episodeId', (req: any, res) => safeRun('Hianime', async () => {
        const p = new ANIME.Hianime();
        const servers = ["vidcloud", "megacloud", "streamtape"];
        for (const server of servers) {
            try { return await p.fetchEpisodeSources(req.params.episodeId, server as any); } catch (e) {}
        }
        throw new Error("No servers found");
    }, res));

    // --- PROXY ---
    fastify.get('/proxy', async (req: any, reply: FastifyReply) => {
        try {
            const { url } = req.query;
            if (!url) return reply.status(400).send("Missing URL");
            const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://kwik.cx/' } });
            reply.header("Access-Control-Allow-Origin", "*");
            reply.header("Content-Type", response.headers.get("content-type") || "application/octet-stream");
            reply.send(Buffer.from(await response.arrayBuffer()));
        } catch (e) { reply.status(500).send({ error: "Proxy Error" }); }
    });
};

export default routes;