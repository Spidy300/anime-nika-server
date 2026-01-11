import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import { ANIME } from '@consumet/extensions';

const gogo = new ANIME.Gogoanime();

const routes = async (fastify: FastifyInstance, options: any) => {

  const proxyHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const { url, headers } = request.query as { url: string, headers?: string };
    if (!url) return reply.status(400).send("Missing URL");

    try {
        const fetchHeaders = headers ? JSON.parse(headers) : {};
        if (!fetchHeaders['User-Agent']) {
            fetchHeaders['User-Agent'] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
        }
        const response = await fetch(url, { headers: fetchHeaders });
        const data = await response.arrayBuffer();
        
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Content-Type", response.headers.get("content-type") || "application/vnd.apple.mpegurl");
        reply.send(Buffer.from(data));
    } catch (error) {
        console.error("Gogo Proxy Error:", error);
        reply.status(500).send("Failed to proxy");
    }
  };

  const searchHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.params as { query: string }).query;
    const res = await gogo.search(query);
    reply.status(200).send(res);
  };

  const infoHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    const res = await gogo.fetchAnimeInfo(id);
    reply.status(200).send(res);
  };

  const watchHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const episodeId = (request.params as { episodeId: string }).episodeId;
    const res = await gogo.fetchEpisodeSources(episodeId);
    reply.status(200).send(res);
  };

  // --- RELATIVE ROUTES ---
  fastify.get('/proxy', proxyHandler);
  fastify.get('/:query', searchHandler);
  fastify.get('/info/:id', infoHandler);
  fastify.get('/watch/:episodeId', watchHandler);
};

export default routes;