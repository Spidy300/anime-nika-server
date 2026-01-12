import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

const PROXY_URL = "https://anime-proxyc.sudeepb9880.workers.dev"; 

async function fetchShield(targetUrl: string, referer?: string) {
    let fullUrl = `${PROXY_URL}?url=${encodeURIComponent(targetUrl)}`;
    // Mobile User-Agent to request simpler, unencrypted players
    fullUrl += `&headers=${encodeURIComponent(JSON.stringify({
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Referer': referer || 'https://gogoanimes.fi/'
    }))}`;
    
    try {
        const res = await fetch(fullUrl);
        if (!res.ok) throw new Error(`Shield Status: ${res.status}`);
        return await res.text();
    } catch (e) {
        return "";
    }
}

class CustomGogo {
    mirrors = ["https://anitaku.pe", "https://gogoanimes.fi", "https://gogoanime3.co"];
    
    async search(query: string) {
        const guessId = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return { 
            results: [{ 
                id: guessId, 
                title: query, 
                image: "https://gogocdn.net/cover/naruto-shippuden.png", 
                releaseDate: "Gogo Only" 
            }] 
        };
    }

    async fetchAnimeInfo(id: string) {
        console.log(chalk.blue(`   -> Gogo: Hunting for info on ${id}...`));
        
        for (const domain of this.mirrors) {
            const html = await fetchShield(`${domain}/category/${id}`);
            if (!html || html.includes("WAF") || html.includes("Verify")) continue;

            const $ = cheerio.load(html);
            const movie_id = $('#movie_id').attr('value');
            const alias = $('#alias_anime').attr('value');
            let ep_end = $('#episode_page a').last().attr('ep_end') || "2000";

            if (movie_id) {
                console.log(chalk.green(`      ✅ Found movie_id: ${movie_id} on ${domain}`));
                
                const ajaxStrategies = [
                    `${domain}/ajax/load-list-episode`, 
                    "https://ajax.gogo-load.com/ajax/load-list-episode",
                    "https://ajax.gogocdn.net/ajax/load-list-episode"
                ];

                for (const ajaxBase of ajaxStrategies) {
                    try {
                        const ajaxUrl = `${ajaxBase}?ep_start=0&ep_end=${ep_end}&id=${movie_id}&default_ep=0&alias=${alias}`;
                        const epHtml = await fetchShield(ajaxUrl, domain); 
                        
                        if (epHtml.includes("Redirecting")) continue;

                        const $ep = cheerio.load(epHtml);
                        const episodes: any[] = [];
                        
                        $ep('li').each((i, el) => {
                            let epId = $ep(el).find('a').attr('href')?.trim() || "";
                            epId = epId.replace(/^\//, '');
                            if (epId.startsWith('-') || (id && !epId.includes(id))) {
                                const suffix = epId.replace(/^-+/, ''); 
                                epId = `${id}-${suffix}`;
                            }
                            const epNum = $ep(el).find('.name').text().replace('EP ', '').trim();
                            if (epId) episodes.push({ id: epId, number: Number(epNum) });
                        });

                        if (episodes.length > 0) {
                            console.log(chalk.green(`      🎉 Success: Connected to ${ajaxBase} (${episodes.length} eps)`));
                            return { id, title: id, episodes: episodes.reverse() };
                        }
                    } catch (e) {}
                }
            }
        }
        throw new Error("Gogo Info Failed");
    }

    async fetchEpisodeSources(episodeId: string) {
        console.log(chalk.blue(`   -> Gogo: Fetching source for ${episodeId}...`));

        for (const domain of this.mirrors) {
            try {
                const html = await fetchShield(`${domain}/${episodeId}`);
                if (!html) continue;

                const $ = cheerio.load(html);

                // 🟢 1. EXTRACT REAL ID (Fixing the garbage ID bug)
                let iframeSrc = $('.anime_muti_link ul li.vidcdn a').attr('data-video') || $('iframe').first().attr('src') || "";
                
                // Regex to grab only the Base64 ID (alphanumeric + =)
                // Stops at & or ? to avoid grabbing junk like "?ep=8308"
                const idMatch = iframeSrc.match(/[?&]id=([a-zA-Z0-9+=]+)/);
                
                if (idMatch && idMatch[1]) {
                    const cleanId = idMatch[1];
                    console.log(chalk.green(`      Found Clean ID: ${cleanId}`));

                    // 🟢 2. CONSTRUCT VIDSTREAMING URL
                    const playerUrl = `https://embtaku.pro/streaming.php?id=${cleanId}`;
                    const playerHtml = await fetchShield(playerUrl, domain);

                    // 🟢 3. STRICT M3U8 SEARCH
                    // Only accept strings ending in .m3u8
                    const m3u8Match = playerHtml.match(/(https?:\/\/[^"']+\.m3u8)/);
                    
                    if (m3u8Match && m3u8Match[1]) {
                        console.log(chalk.green(`      🎉 FOUND VALID M3U8: ${m3u8Match[1]}`));
                        return { sources: [{ url: m3u8Match[1], quality: 'default', isM3U8: true }] };
                    }
                    
                    // 🟢 4. STRICT MP4 SEARCH (Legacy Fallback)
                    const mp4Match = playerHtml.match(/file:\s*['"](https?:\/\/[^"']+\.mp4)['"]/);
                    if (mp4Match && mp4Match[1]) {
                         console.log(chalk.green(`      🎉 FOUND VALID MP4: ${mp4Match[1]}`));
                         return { sources: [{ url: mp4Match[1], quality: 'default', isM3U8: false }] };
                    }
                } else {
                    console.log(chalk.yellow("      ⚠️ Could not extract clean ID from iframe."));
                }

                // 🟢 5. NEW BACKUP: VIDSTACK API
                // If local scraping fails, try this dedicated Gogo scraper API
                try {
                    console.log(chalk.gray("      Trying Vidstack API..."));
                    const vidstackUrl = `https://api.consumet.org/anime/gogoanime/watch/${episodeId}`;
                    const res = await fetch(vidstackUrl);
                    if (res.ok) {
                        const data = await res.json();
                        // Validate the result!
                        if (data.sources && data.sources[0] && data.sources[0].url.endsWith('.m3u8')) {
                             console.log(chalk.green(`      🎉 VIDSTACK SUCCESS: ${data.sources[0].url}`));
                             return { sources: [{ url: data.sources[0].url, quality: 'default', isM3U8: true }] };
                        }
                    }
                } catch(e) {}

            } catch(e) {}
        }
        
        throw new Error("Gogo Watch Failed - No playable video file found");
    }
}

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

  fastify.get('/gogo/search/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/gogo/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/gogo/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));

  // Default
  fastify.get('/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));

  fastify.get('/proxy', async (req: any, reply: FastifyReply) => {
    try {
        const { url } = req.query;
        if (!url) return reply.status(400).send("Missing URL");
        
        // 🟢 FIX: Do not proxy HTML pages as video
        if (url.includes('.php') || url.includes('.html')) {
             return reply.status(400).send("Proxy refused: Not a video file");
        }

        const fullUrl = `${PROXY_URL}?url=${encodeURIComponent(url)}`;
        const response = await fetch(fullUrl);
        reply.header("Access-Control-Allow-Origin", "*");
        reply.send(Buffer.from(await response.arrayBuffer()));
    } catch (e) { reply.status(500).send({ error: "Proxy Error" }); }
  });
};

export default routes;