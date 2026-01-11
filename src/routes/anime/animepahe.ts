import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import { ANIME } from '@consumet/extensions';

const hianime = new ANIME.Hianime();
const animepahe = new ANIME.AnimePahe();
const animekai = new ANIME.AnimeKai(); 

// Gogoanime Loader
let gogo: any;
try {
    // @ts-ignore
    if ((ANIME as any).Gogoanime) gogo = new (ANIME as any).Gogoanime();
    else {
        const GogoClass = require('@consumet/extensions/dist/providers/anime/gogoanime').default;
        gogo = new GogoClass();
    }
} catch (e) { }

const routes = async (fastify: FastifyInstance, options: any) => {

  const proxyHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { url } = request.query as { url: string };
        if (!url) return reply.status(400).send("Missing URL");

        // 🟢 THE UNIVERSAL LOGIC (Fixes "Pro25Zone", "Net22Lab", etc.)
        // Default to AnimeKai for ANY unknown server.
        let referer = "https://animekai.to/"; 

        // Specific Overrides
        if (url.includes("uwucdn") || url.includes("kwik") || url.includes("owocdn")) {
            referer = "https://kwik.cx/";
        }
        else if (url.includes("gogocdn") || url.includes("goload") || url.includes("gogohd")) {
            referer = "https://gogotaku.info/";
        }

        const fetchHeaders: any = {
            'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            'Referer': referer,
            'Origin': new URL(referer).origin,
            'Accept': '*/*'
        };

        const response = await fetch(url, { headers: fetchHeaders });
        if (!response.ok) return reply.status(response.status).send(`Upstream Error: ${response.statusText}`);

        const contentType = response.headers.get("content-type") || "";

        // M3U8 Rewriter (Fixes 404s)
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

        // Standard Stream
        const buffer = await response.arrayBuffer();
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Content-Type", contentType);
        reply.send(Buffer.from(buffer));

    } catch (error) {
        reply.status(500).send({ error: "Proxy failed" });
    }
  };

  // Handlers
  const kaiSearch = async (req: any, reply: any) => { try { const res = await animekai.search(req.params.query); reply.send(res); } catch (e) { reply.status(500).send({}); } };
  const kaiInfo = async (req: any, reply: any) => { try { const res = await animekai.fetchAnimeInfo(req.params.id); reply.send(res); } catch (e) { reply.status(500).send({}); } };
  const kaiWatch = async (req: any, reply: any) => { try { const res = await animekai.fetchEpisodeSources(req.params.episodeId); reply.send(res); } catch (e) { reply.status(500).send({}); } };

  const gogoSearch = async (req: any, reply: any) => { try { if(gogo) reply.send(await gogo.search(req.params.query)); else throw 0; } catch (e) { reply.status(500).send({}); } };
  const gogoInfo = async (req: any, reply: any) => { try { if(gogo) reply.send(await gogo.fetchAnimeInfo(req.params.id)); else throw 0; } catch (e) { reply.status(500).send({}); } };
  const gogoWatch = async (req: any, reply: any) => { try { if(gogo) reply.send(await gogo.fetchEpisodeSources(req.params.episodeId)); else throw 0; } catch (e) { reply.status(500).send({}); } };

  const hiSearch = async (req: any, reply: any) => { try { const res = await hianime.search(req.params.query); reply.send(res); } catch (e) { reply.status(500).send({}); } };
  const hiInfo = async (req: any, reply: any) => { try { const res = await hianime.fetchAnimeInfo(req.params.id); reply.send(res); } catch (e) { reply.status(500).send({}); } };
  const hiWatch = async (req: any, reply: any) => {
    const servers = ["vidstreaming", "vidcloud", "streamsb", "streamtape"];
    for (const server of servers) { try { const res = await hianime.fetchEpisodeSources(req.params.episodeId, server as any); return reply.send(res); } catch (e) {} }
    reply.status(500).send({});
  };

  const paheSearch = async (req: any, reply: any) => { try { const res = await animepahe.search(req.params.query); reply.send(res); } catch (e) { reply.status(500).send({}); } };
  const paheInfo = async (req: any, reply: any) => { try { const res = await animepahe.fetchAnimeInfo(req.params.id); reply.send(res); } catch (e) { reply.status(500).send({}); } };
  const paheWatch = async (req: any, reply: any) => { try { let id=req.params.episodeId; if(id.includes("~")) id=id.replace(/~/g,"/"); const res=await animepahe.fetchEpisodeSources(id); reply.send(res); } catch (e) { reply.status(500).send({}); } };

  fastify.get('/proxy', proxyHandler);
  
  fastify.get('/kai/search/:query', kaiSearch);
  fastify.get('/kai/info/:id', kaiInfo);
  fastify.get('/kai/watch/:episodeId', kaiWatch);

  fastify.get('/gogo/search/:query', gogoSearch);
  fastify.get('/gogo/info/:id', gogoInfo);
  fastify.get('/gogo/watch/:episodeId', gogoWatch);

  fastify.get('/hianime/search/:query', hiSearch);
  fastify.get('/hianime/info/:id', hiInfo);
  fastify.get('/hianime/watch/:episodeId', hiWatch);

  fastify.get('/:query', paheSearch);
  fastify.get('/info/:id', paheInfo);
  fastify.get('/watch/:episodeId', paheWatch);
};

export default routes;