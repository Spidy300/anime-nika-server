import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import { ANIME } from '@consumet/extensions';
import chalk from 'chalk';

const routes = async (fastify: FastifyInstance, options: any) => {

  // --- HELPER: LAZY LOAD PROVIDERS (Saves RAM) ---
  const getProvider = (name: string) => {
      try {
          if (name === 'kai') return new ANIME.AnimeKai();
          if (name === 'hianime') return new ANIME.Hianime();
          if (name === 'pahe') return new ANIME.AnimePahe();
          if (name === 'gogo') {
              // 🟢 FORCE LOAD GOGO (Bypasses TypeScript issues)
              try {
                  return new ANIME.Gogoanime();
              } catch (e) {
                  // Fallback for different environments
                  const Gogo = require('@consumet/extensions/dist/providers/anime/gogoanime').default;
                  return new Gogo();
              }
          }
      } catch (e) {
          console.error(chalk.red(`Failed to load ${name}:`), e);
          return null;
      }
  };

  // --- HELPER: SAFE RUNNER (Prevents 502 Crashes) ---
  const safeRun = async (providerName: string, action: string, fn: (p: any) => Promise<any>, reply: any) => {
    try {
        console.log(chalk.blue(`[${providerName}] Request: ${action}...`));
        
        const provider = getProvider(providerName.toLowerCase());
        if (!provider) throw new Error(`${providerName} could not be initialized.`);

        // Set a timeout of 15 seconds to prevent freezing
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Request timed out (15s)")), 15000));
        const result = await Promise.race([fn(provider), timeout]);

        console.log(chalk.green(`   -> [${providerName}] Success!`));
        return reply.send(result);

    } catch (e: any) {
        console.error(chalk.red(`   -> ❌ [${providerName}] Failed:`), e.message);
        // Send 200 with empty results instead of 500/502 so frontend keeps trying others
        return reply.status(200).send({ error: e.message, results: [] }); 
    }
  };

  // --- ROUTES ---

  // AnimeKai
  fastify.get('/kai/search/:query', (req: any, res) => safeRun('Kai', `Search ${req.params.query}`, (p) => p.search(req.params.query), res));
  fastify.get('/kai/info/:id', (req: any, res) => safeRun('Kai', `Info ${req.params.id}`, (p) => p.fetchAnimeInfo(req.params.id), res));
  fastify.get('/kai/watch/:episodeId', (req: any, res) => safeRun('Kai', `Watch ${req.params.episodeId}`, (p) => p.fetchEpisodeSources(req.params.episodeId), res));

  // Gogoanime
  fastify.get('/gogo/search/:query', (req: any, res) => safeRun('Gogo', `Search ${req.params.query}`, (p) => p.search(req.params.query), res));
  fastify.get('/gogo/info/:id', (req: any, res) => safeRun('Gogo', `Info ${req.params.id}`, (p) => p.fetchAnimeInfo(req.params.id), res));
  fastify.get('/gogo/watch/:episodeId', (req: any, res) => safeRun('Gogo', `Watch ${req.params.episodeId}`, (p) => p.fetchEpisodeSources(req.params.episodeId), res));

  // Hianime
  fastify.get('/hianime/search/:query', (req: any, res) => safeRun('Hianime', `Search ${req.params.query}`, (p) => p.search(req.params.query), res));
  fastify.get('/hianime/info/:id', (req: any, res) => safeRun('Hianime', `Info ${req.params.id}`, (p) => p.fetchAnimeInfo(req.params.id), res));
  fastify.get('/hianime/watch/:episodeId', (req: any, res) => safeRun('Hianime', `Watch ${req.params.episodeId}`, async (p) => {
    const servers = ["vidstreaming", "vidcloud", "streamsb", "streamtape"];
    for (const server of servers) { 
        try { return await p.fetchEpisodeSources(req.params.episodeId, server); } catch (e) {} 
    }
    throw new Error("No servers found");
  }, res));

  // AnimePahe
  fastify.get('/:query', (req: any, res) => safeRun('Pahe', `Search ${req.params.query}`, (p) => p.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Pahe', `Info ${req.params.id}`, (p) => p.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Pahe', `Watch ${req.params.episodeId}`, (p) => {
      let id = req.params.episodeId;
      if(id.includes("~")) id = id.replace(/~/g,"/");
      return p.fetchEpisodeSources(id);
  }, res));

  // --- PROXY HANDLER (Universal) ---
  fastify.get('/proxy', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { url } = request.query as { url: string };
        if (!url) return reply.status(400).send("Missing URL");

        let referer = "https://animekai.to/"; 
        if (url.includes("uwucdn") || url.includes("kwik")) referer = "https://kwik.cx/";
        else if (url.includes("gogocdn") || url.includes("goload")) referer = "https://gogotaku.info/";

        const response = await fetch(url, { headers: { 'Referer': referer, 'User-Agent': "Mozilla/5.0" } });
        
        // Forward Headers (Fixes CORS)
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Content-Type", response.headers.get("content-type") || "application/octet-stream");

        const buffer = await response.arrayBuffer();
        reply.send(Buffer.from(buffer));

    } catch (error) {
        reply.status(500).send({ error: "Proxy Error" });
    }
  });
};

export default routes;