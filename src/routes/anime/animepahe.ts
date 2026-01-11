import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import { ANIME } from '@consumet/extensions';
import chalk from 'chalk';

// --- INITIALIZE PROVIDERS ---
const hianime = new ANIME.Hianime();
const animepahe = new ANIME.AnimePahe();
const animekai = new ANIME.AnimeKai(); 

// --- ROBUST GOGO LOADER ---
let gogo: any;
try {
    // Try standard load
    gogo = new ANIME.Gogoanime();
    console.log(chalk.green("✅ Gogoanime loaded successfully!"));
} catch (e) {
    console.log(chalk.red("⚠️ Standard Gogo load failed. Trying fallback..."));
    try {
        // Try fallback load (common in some environments)
        // @ts-ignore
        if (ANIME.Gogoanime) gogo = new ANIME.Gogoanime();
        else {
             // @ts-ignore
            const GogoClass = require('@consumet/extensions/dist/providers/anime/gogoanime').default;
            gogo = new GogoClass();
        }
        console.log(chalk.green("✅ Gogoanime fallback loaded!"));
    } catch (err) {
        console.error(chalk.red("❌ Gogoanime COMPLETELY failed to load."));
    }
}

const routes = async (fastify: FastifyInstance, options: any) => {

  // --- PROXY HANDLER (Fixes 403 Errors) ---
  const proxyHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { url } = request.query as { url: string };
        if (!url) return reply.status(400).send("Missing URL");

        // Universal Catch-All Logic
        let referer = "https://animekai.to/"; 
        if (url.includes("uwucdn") || url.includes("kwik") || url.includes("owocdn")) referer = "https://kwik.cx/";
        else if (url.includes("gogocdn") || url.includes("goload") || url.includes("gogohd")) referer = "https://gogotaku.info/";

        const response = await fetch(url, { 
            headers: { 
                'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                'Referer': referer,
                'Origin': new URL(referer).origin
            } 
        });
        
        if (!response.ok) return reply.status(response.status).send(`Upstream Error: ${response.statusText}`);

        // Rewriter for M3U8
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("mpegurl") || url.includes(".m3u8")) {
            const text = await response.text();
            const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
            const modifiedText = text.replace(/^(?!#|http)(.*)$/gm, (match) => {
                if (!match.trim()) return match;
                try { return new URL(match, baseUrl).href; } catch (e) { return match; }
            });
            reply.header("Access-Control-Allow-Origin", "*");
            reply.header("Content-Type", "application/vnd.apple.mpegurl");
            return reply.send(modifiedText);
        }

        const buffer = await response.arrayBuffer();
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Content-Type", contentType);
        reply.send(Buffer.from(buffer));

    } catch (error) {
        reply.status(500).send({ error: "Proxy failed" });
    }
  };

  // --- HELPER TO LOG ERRORS ---
  const safeRun = async (providerName: string, action: string, fn: () => Promise<any>, reply: any) => {
    try {
        console.log(chalk.blue(`[${providerName}] ${action}...`));
        const res = await fn();
        console.log(chalk.green(`   -> Success (${Array.isArray(res.results) ? res.results.length + ' results' : 'OK'})`));
        reply.send(res);
    } catch (e: any) {
        console.error(chalk.red(`   -> ❌ ERROR in ${providerName} ${action}:`), e.message);
        reply.status(500).send({ error: e.message });
    }
  };

  // --- ROUTE DEFINITIONS ---

  // AnimeKai
  fastify.get('/kai/search/:query', (req: any, res) => safeRun('Kai', `Searching: ${req.params.query}`, () => animekai.search(req.params.query), res));
  fastify.get('/kai/info/:id', (req: any, res) => safeRun('Kai', `Info: ${req.params.id}`, () => animekai.fetchAnimeInfo(req.params.id), res));
  fastify.get('/kai/watch/:episodeId', (req: any, res) => safeRun('Kai', `Watch: ${req.params.episodeId}`, () => animekai.fetchEpisodeSources(req.params.episodeId), res));

  // Gogoanime
  fastify.get('/gogo/search/:query', (req: any, res) => {
      if(!gogo) return res.status(500).send({error: "Gogo not loaded"});
      safeRun('Gogo', `Searching: ${req.params.query}`, () => gogo.search(req.params.query), res)
  });
  fastify.get('/gogo/info/:id', (req: any, res) => {
      if(!gogo) return res.status(500).send({error: "Gogo not loaded"});
      safeRun('Gogo', `Info: ${req.params.id}`, () => gogo.fetchAnimeInfo(req.params.id), res)
  });
  fastify.get('/gogo/watch/:episodeId', (req: any, res) => {
      if(!gogo) return res.status(500).send({error: "Gogo not loaded"});
      safeRun('Gogo', `Watch: ${req.params.episodeId}`, () => gogo.fetchEpisodeSources(req.params.episodeId), res)
  });

  // Hianime
  fastify.get('/hianime/search/:query', (req: any, res) => safeRun('Hianime', `Searching: ${req.params.query}`, () => hianime.search(req.params.query), res));
  fastify.get('/hianime/info/:id', (req: any, res) => safeRun('Hianime', `Info: ${req.params.id}`, () => hianime.fetchAnimeInfo(req.params.id), res));
  fastify.get('/hianime/watch/:episodeId', async (req: any, res) => {
    const servers = ["vidstreaming", "vidcloud", "streamsb", "streamtape"];
    for (const server of servers) { 
        try { 
            const data = await hianime.fetchEpisodeSources(req.params.episodeId, server as any);
            return res.send(data);
        } catch (e) {} 
    }
    res.status(500).send({error: "All servers failed"});
  });

  // AnimePahe
  fastify.get('/:query', (req: any, res) => safeRun('Pahe', `Searching: ${req.params.query}`, () => animepahe.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Pahe', `Info: ${req.params.id}`, () => animepahe.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => {
      let id = req.params.episodeId;
      if(id.includes("~")) id = id.replace(/~/g,"/");
      safeRun('Pahe', `Watch: ${id}`, () => animepahe.fetchEpisodeSources(id), res);
  });

  fastify.get('/proxy', proxyHandler);
};

export default routes;