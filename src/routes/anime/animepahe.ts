import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import chalk from 'chalk';
import * as cheerio from 'cheerio';
import { ANIME } from '@consumet/extensions';

// --- RENDER-OPTIMIZED PROXY TUNNEL ---
async function fetchTunnel(targetUrl: string, retries = 2) {
    const proxies = [
        (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
        (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
        (url: string) => url // Direct fetch as fallback
    ];

    for (let attempt = 0; attempt < retries; attempt++) {
        for (const proxyFn of proxies) {
            try {
                const proxyUrl = proxyFn(targetUrl);
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 6000);
                
                const res = await fetch(proxyUrl, { 
                    signal: controller.signal,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                    }
                });
                
                clearTimeout(timeoutId);
                
                if (res.ok) {
                    const text = await res.text();
                    if (text && text.length > 100) return text;
                }
            } catch (e) {
                continue;
            }
        }
    }

    console.log(chalk.red(`   -> All proxies failed for: ${targetUrl}`));
    return null;
}

// --- RENDER-OPTIMIZED GOGO CLASS ---
class CustomGogo {
    domains = [
        "https://anitaku.to",
        "https://gogoanime3.co", 
        "https://gogoanime3.net"
    ];

    async search(query: string) {
        const guessId = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        
        for (const domain of this.domains.slice(0, 2)) {
            try {
                const html = await fetchTunnel(`${domain}/search.html?keyword=${encodeURIComponent(query)}`);
                if (!html) continue;

                const $ = cheerio.load(html);
                const results: any[] = [];
                
                $('.items li').each((i, el) => {
                    if (i >= 15) return false;
                    const $el = $(el);
                    const title = $el.find('.name a').text().trim();
                    const id = $el.find('.name a').attr('href')?.replace('/category/', '').trim();
                    const image = $el.find('img').attr('src');
                    const releaseDate = $el.find('.released').text().replace('Released:', '').trim();
                    
                    if (id && title) {
                        results.push({ id, title, image, releaseDate });
                    }
                });

                if (results.length > 0) return { results };
            } catch (e) {
                continue;
            }
        }

        return { 
            results: [{ 
                id: guessId, 
                title: query, 
                image: "https://gogocdn.net/cover/default.png", 
                releaseDate: "Search Result" 
            }] 
        };
    }

    async fetchAnimeInfo(id: string) {
        for (const domain of this.domains.slice(0, 2)) {
            try {
                const html = await fetchTunnel(`${domain}/category/${id}`);
                if (!html) continue;

                const $ = cheerio.load(html);
                const title = $('.anime_info_body_bg h1').text().trim();
                const movie_id = $('#movie_id').attr('value');
                const alias = $('#alias_anime').attr('value');
                const ep_end = $('#episode_page a').last().attr('ep_end') || '500';

                if (!movie_id) continue;

                const ajaxUrl = `https://ajax.gogocdn.net/ajax/load-list-episode?ep_start=0&ep_end=${ep_end}&id=${movie_id}&default_ep=0&alias=${alias}`;
                const epHtml = await fetchTunnel(ajaxUrl);
                if (!epHtml) continue;

                const $ep = cheerio.load(epHtml);
                const episodes: any[] = [];
                
                $ep('li').each((i, el) => {
                    const epId = $ep(el).find('a').attr('href')?.trim().replace('/', '');
                    const epNum = $ep(el).find('.name').text().replace('EP ', '').trim();
                    if (epId) episodes.push({ id: epId, number: Number(epNum) || i + 1 });
                });

                if (episodes.length > 0) {
                    return { id, title: title || id, episodes: episodes.reverse() };
                }
            } catch (e) {
                continue;
            }
        }

        throw new Error("Gogo: Unable to fetch info (site may be down)");
    }

    async fetchEpisodeSources(episodeId: string) {
        for (const domain of this.domains.slice(0, 1)) {
            try {
                const html = await fetchTunnel(`${domain}/${episodeId}`);
                if (!html) continue;

                const $ = cheerio.load(html);
                const sources: any[] = [];
                
                $('iframe').each((i, el) => {
                    const src = $(el).attr('src');
                    if (src) {
                        sources.push({ 
                            url: src.startsWith('//') ? 'https:' + src : src, 
                            quality: 'default', 
                            isM3U8: src.includes('.m3u8') 
                        });
                    }
                });

                if (sources.length > 0) {
                    return { sources };
                }
            } catch (e) {
                continue;
            }
        }

        throw new Error("No video sources found");
    }
}

// --- RENDER-OPTIMIZED PAHE CLASS ---
class CustomPahe {
    baseUrl = "https://animepahe.ru";
    headers = { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://animepahe.ru/'
    };

    async search(query: string) {
        try {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 6000);
            
            const res = await fetch(
                `${this.baseUrl}/api?m=search&q=${encodeURIComponent(query)}`, 
                { headers: this.headers, signal: controller.signal }
            );
            const data: any = await res.json();
            return { results: (data.data || []).map((i:any) => ({ 
                id: i.session, 
                title: i.title, 
                image: i.poster 
            })) };
        } catch (e) { 
            return { results: [] }; 
        }
    }

    async fetchAnimeInfo(id: string) {
        try {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 6000);
            
            const res = await fetch(
                `${this.baseUrl}/api?m=release&id=${id}&sort=episode_asc&page=1`, 
                { headers: this.headers, signal: controller.signal }
            );
            const data: any = await res.json();
            const episodes = (data.data || []).map((ep:any) => ({ 
                id: `${id}*${ep.session}`, 
                number: ep.episode 
            }));
            return { id, title: "AnimePahe", episodes };
        } catch (e) { 
            throw new Error("Pahe Info Error"); 
        }
    }

    async fetchEpisodeSources(episodeId: string) {
        try {
            if (!episodeId.includes("*")) throw new Error("Invalid ID format");
            const [animeId, epId] = episodeId.split("*");
            
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 8000);
            
            const res = await fetch(
                `${this.baseUrl}/play/${animeId}/${epId}`, 
                { headers: this.headers, signal: controller.signal }
            );
            const html = await res.text();
            
            const kwikMatch = html.match(/https?:\/\/kwik\.[a-z]+\/e\/[a-zA-Z0-9]+/);
            if (!kwikMatch) {
                const altMatch = html.match(/https?:\/\/[a-z0-9.-]+\/e\/[a-zA-Z0-9]+/);
                if (altMatch) {
                    return { sources: [{ url: altMatch[0], quality: '720p', isM3U8: false }] };
                }
                throw new Error("No video link found");
            }
            
            return { sources: [{ url: kwikMatch[0], quality: '720p', isM3U8: false }] };
        } catch (e: any) { 
            throw new Error("Pahe Watch Error: " + e.message); 
        }
    }
}

// --- FIXED HIANIME WRAPPER (No Class Extension) ---
async function fetchHianimeEpisodeSources(episodeId: string, server?: string) {
    const hianime = new ANIME.Hianime();
    const serverOrder = ["megacloud", "vidstreaming", "vidcloud", "streamtape"];
    const serversToTry = server ? [server, ...serverOrder.filter(s => s !== server)] : serverOrder;
    
    for (const srv of serversToTry.slice(0, 2)) { // Only try 2 servers for speed
        try {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 8000);
            
            // Create a promise that will timeout
            const fetchPromise = hianime.fetchEpisodeSources(episodeId, srv as any);
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Timeout')), 8000)
            );
            
            const result: any = await Promise.race([fetchPromise, timeoutPromise]);
            
            if (result && result.sources && result.sources.length > 0) {
                console.log(`   -> Server ${srv} worked!`);
                return result;
            }
        } catch (e: any) {
            console.log(`   -> Server ${srv} failed: ${e.message}`);
            continue;
        }
    }
    
    throw new Error("Hianime: No working servers (try Pahe provider)");
}

const customGogo = new CustomGogo();
const customPahe = new CustomPahe();

const routes = async (fastify: FastifyInstance, options: any) => {
  const safeRun = async (providerName: string, fn: () => Promise<any>, reply: any) => {
    const startTime = Date.now();
    
    try {
        console.log(chalk.blue(`[${providerName}] Running...`));
        const res = await fn();
        const duration = Date.now() - startTime;
        console.log(chalk.green(`   -> Success (${duration}ms)`));
        return reply.send(res);
    } catch (e: any) {
        const duration = Date.now() - startTime;
        console.error(chalk.red(`   -> Error (${duration}ms):`), e.message);
        return reply.status(200).send({ 
            error: e.message, 
            results: [], 
            sources: [],
            suggestion: providerName !== 'Pahe' ? 'Try using Pahe provider' : 'Provider temporarily unavailable'
        });
    }
  };

  // GOGO ROUTES
  fastify.get('/gogo/search/:query', (req: any, res) => 
    safeRun('Gogo', () => customGogo.search(req.params.query), res)
  );
  
  fastify.get('/gogo/info/:id', (req: any, res) => 
    safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res)
  );
  
  fastify.get('/gogo/watch/:episodeId', (req: any, res) => 
    safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res)
  );

  // PAHE ROUTES (Primary - Most Reliable)
  fastify.get('/:query', (req: any, res) => 
    safeRun('Pahe', () => customPahe.search(req.params.query), res)
  );
  
  fastify.get('/info/:id', (req: any, res) => 
    safeRun('Pahe', () => customPahe.fetchAnimeInfo(req.params.id), res)
  );
  
  fastify.get('/watch/:episodeId', (req: any, res) => 
    safeRun('Pahe', () => {
      let id = req.params.episodeId.includes("~") 
        ? req.params.episodeId.replace(/~/g, "*") 
        : req.params.episodeId;
      return customPahe.fetchEpisodeSources(id);
    }, res)
  );

  // HIANIME ROUTES (Using wrapper function instead of class)
  fastify.get('/hianime/search/:query', (req: any, res) => 
    safeRun('Hianime', () => new ANIME.Hianime().search(req.params.query), res)
  );
  
  fastify.get('/hianime/info/:id', (req: any, res) => 
    safeRun('Hianime', () => new ANIME.Hianime().fetchAnimeInfo(req.params.id), res)
  );
  
  fastify.get('/hianime/watch/:episodeId', (req: any, res) => 
    safeRun('Hianime', () => fetchHianimeEpisodeSources(req.params.episodeId, req.query.server), res)
  );

  // IMPROVED PROXY for Render
  fastify.get('/proxy', async (req: any, reply: FastifyReply) => {
    try {
        const { url } = req.query;
        if (!url) return reply.status(400).send({ error: "Missing URL parameter" });
        
        let referer = "https://gogoanime3.co/";
        if (url.includes("kwik")) referer = "https://kwik.cx/";
        if (url.includes("hianime")) referer = "https://hianime.to/";
        if (url.includes("anitaku")) referer = "https://anitaku.to/";

        const controller = new AbortController();
        setTimeout(() => controller.abort(), 12000);

        const response = await fetch(url, { 
            headers: { 
                'Referer': referer, 
                'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                'Accept': '*/*',
                'Origin': referer.replace(/\/$/, '')
            },
            signal: controller.signal
        });
        
        if (!response.ok) {
            throw new Error(`Fetch failed: ${response.status}`);
        }

        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Access-Control-Allow-Methods", "GET, OPTIONS");
        reply.header("Access-Control-Allow-Headers", "Content-Type, Range");
        reply.header("Content-Type", response.headers.get("content-type") || "application/octet-stream");
        
        const range = response.headers.get("content-range");
        if (range) {
            reply.header("Content-Range", range);
            reply.header("Accept-Ranges", "bytes");
        }
        
        reply.send(Buffer.from(await response.arrayBuffer()));
    } catch (e: any) { 
        console.error("Proxy error:", e.message);
        reply.status(500).send({ error: "Proxy failed: " + e.message }); 
    }
  });

  // Health check for Render monitoring
  fastify.get('/health', async (req, reply) => {
    reply.send({ 
      status: 'ok',
      timestamp: new Date().toISOString(),
      providers: {
        pahe: 'primary',
        gogo: 'secondary',
        hianime: 'backup'
      },
      note: 'Use Pahe provider for best results'
    });
  });

  // Root endpoint
  fastify.get('/', async (req, reply) => {
    reply.send({
      message: 'Anime API Server - Fixed & Optimized',
      endpoints: {
        pahe: {
          search: '/:query',
          info: '/info/:id',
          watch: '/watch/:episodeId'
        },
        gogo: {
          search: '/gogo/search/:query',
          info: '/gogo/info/:id',
          watch: '/gogo/watch/:episodeId'
        },
        hianime: {
          search: '/hianime/search/:query',
          info: '/hianime/info/:id',
          watch: '/hianime/watch/:episodeId'
        },
        utility: {
          proxy: '/proxy?url=VIDEO_URL',
          health: '/health'
        }
      }
    });
  });
};

export default routes;