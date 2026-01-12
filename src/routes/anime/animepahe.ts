import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import { ANIME } from '@consumet/extensions';
import chalk from 'chalk';

const routes = async (fastify: FastifyInstance, options: any) => {

  // --- HELPER: LAZY LOAD PROVIDERS ---
  const getProvider = (name: string) => {
      try {
          if (name === 'kai') return new ANIME.AnimeKai();
          if (name === 'pahe') return new ANIME.AnimePahe();
          
          // 🟢 NEW: Add KickAssAnime
          if (name === 'kickass') return new ANIME.KickAssAnime();

          if (name === 'hianime') {
              // Try Hianime, fallback to Zoro
              try { return new ANIME.Hianime(); } 
              catch(e) { 
                  // @ts-ignore
                  if (ANIME.Zoro) return new ANIME.Zoro(); 
              }
          }
      } catch (e) {
          console.error(chalk.red(`Failed to load ${name}:`), e);
          return null;
      }
      return null;
  };

  // --- HELPER: SAFE RUNNER ---
  const safeRun = async (providerName: string, action: string, fn: (p: any) => Promise<any>, reply: any) => {
    try {
        console.log(chalk.blue(`[${providerName}] Request: ${action}...`));
        
        const provider = getProvider(providerName.toLowerCase());
        if (!provider) throw new Error(`${providerName} could not be initialized.`);

        // 60s Timeout
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Request timed out (60s)")), 60000));
        const result = await Promise.race([fn(provider), timeout]);

        console.log(chalk.green(`   -> [${providerName}] Success!`));
        return reply.send(result);

    } catch (e: any) {
        console.error(chalk.red(`   -> ❌ [${providerName}] Failed:`), e.message);
        return reply.status(200).send({ error: e.message, results: [] }); 
    }
  };

  // --- ROUTES ---

  // KICKASS ANIME (New!)
  fastify.get('/kickass/search/:query', (req: any, res) => safeRun('KickAss', `Search ${req.params.query}`, (p) => p.search(req.params.query), res));
  fastify.get('/kickass/info/:id', (req: any, res) => safeRun('KickAss', `Info ${req.params.id}`, (p) => p.fetchAnimeInfo(req.params.id), res));
  fastify.get('/kickass/watch/:episodeId', (req: any, res) => safeRun('KickAss', `Watch ${req.params.episodeId}`, (p) => p.fetchEpisodeSources(req.params.episodeId), res));

  // KAI
  fastify.get('/kai/search/:query', (req: any, res) => safeRun('Kai', `Search ${req.params.query}`, (p) => p.search(req.params.query), res));
  fastify.get('/kai/info/:id', (req: any, res) => safeRun('Kai', `Info ${req.params.id}`, (p) => p.fetchAnimeInfo(req.params.id), res));
  fastify.get('/kai/watch/:episodeId', (req: any, res) => safeRun('Kai', `Watch ${req.params.episodeId}`, (p) => p.fetchEpisodeSources(req.params.episodeId), res));

  // HIANIME
  fastify.get('/hianime/search/:query', (req: any, res) => safeRun('Hianime', `Search ${req.params.query}`, (p) => p.search(req.params.query), res));
  fastify.get('/hianime/info/:id', (req: any, res) => safeRun('Hianime', `Info ${req.params.id}`, (p) => p.fetchAnimeInfo(req.params.id), res));
  fastify.get('/hianime/watch/:episodeId', (req: any, res) => safeRun('Hianime', `Watch ${req.params.episodeId}`, async (p) => {
    const servers = ["vidcloud", "megacloud", "vidstreaming", "streamtape"];
    for (const server of servers) { 
        try { 
            console.log(chalk.yellow(`   ...trying Hianime server: ${server}`));
            const data = await p.fetchEpisodeSources(req.params.episodeId, server);
            if(data && data.sources && data.sources.length > 0) return data;
        } catch (e) {} 
    }
    throw new Error("No working servers found.");
  }, res));

  // PAHE
  fastify.get('/:query', (req: any, res) => safeRun('Pahe', `Search ${req.params.query}`, (p) => p.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Pahe', `Info ${req.params.id}`, (p) => p.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Pahe', `Watch ${req.params.episodeId}`, (p) => {
      let id = req.params.episodeId;
      if(id.includes("~")) id = id.replace(/~/g,"/");
      return p.fetchEpisodeSources(id);
  }, res));

  // --- PROXY ---
  fastify.get('/proxy', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { url } = request.query as { url: string };
        if (!url) return reply.status(400).send("Missing URL");
        
        // Universal Referer strategy
        const response = await fetch(url, { headers: { 'Referer': new URL(url).origin, 'User-Agent': "Mozilla/5.0" } });
        
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Content-Type", response.headers.get("content-type") || "application/octet-stream");
        const buffer = await response.arrayBuffer();
        reply.send(Buffer.from(buffer));
    } catch (error) { reply.status(500).send({ error: "Proxy Error" }); }
  });
};

export default routes;