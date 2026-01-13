import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

// 🟢 THE SHIELD WALL (Public Proxies)
// We will cycle through these to hide your server's identity
const PROXIES = [
    "https://corsproxy.io/?", 
    "https://api.codetabs.com/v1/proxy?quest=",
    "https://thingproxy.freeboard.io/fetch/"
];

async function fetchShield(targetUrl: string) {
    // 1. Try Direct first (Just in case it works for some files)
    try {
        const res = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
                'Referer': 'https://gogoanimes.fi/'
            }
        });
        if (res.ok) return await res.text();
    } catch (e) {}

    // 2. Try The Shield Wall
    for (const proxy of PROXIES) {
        try {
            const fullUrl = `${proxy}${encodeURIComponent(targetUrl)}`;
            const res = await fetch(fullUrl);
            
            if (res.ok) {
                const text = await res.text();
                // Ensure we didn't get a block page
                if (text.includes("<!DOCTYPE html") && text.length > 500) {
                    return text;
                }
            }
        } catch (e) {}
    }
    
    // 3. Last Resort: AllOrigins (Returns JSON)
    try {
        const res = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`);
        const data = await res.json() as any;
        if (data.contents) return data.contents;
    } catch (e) {}

    return "";
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
            try {
                // Info pages are usually not blocked, try direct first
                let html = await fetchShield(`${domain}/category/${id}`);
                if (!html) continue;

                const $ = cheerio.load(html);
                const movie_id = $('#movie_id').attr('value');
                const alias = $('#alias_anime').attr('value');
                let ep_end = $('#episode_page a').last().attr('ep_end') || "2000";

                if (movie_id) {
                    console.log(chalk.green(`      ✅ Found movie_id: ${movie_id} on ${domain}`));
                    
                    const ajaxUrl = `https://ajax.gogo-load.com/ajax/load-list-episode?ep_start=0&ep_end=${ep_end}&id=${movie_id}&default_ep=0&alias=${alias}`;
                    const listHtml = await fetchShield(ajaxUrl);
                    
                    const $ep = cheerio.load(listHtml);
                    const episodes: any[] = [];
                    
                    $ep('li').each((i, el) => {
                        let epId = $ep(el).find('a').attr('href')?.trim() || "";
                        epId = epId.replace(/^\//, ''); 
                        const epNum = $ep(el).find('.name').text().replace('EP ', '').trim();
                        if (epId) episodes.push({ id: epId, number: Number(epNum) });
                    });

                    if (episodes.length > 0) {
                        console.log(chalk.green(`      🎉 Success: Found ${episodes.length} eps`));
                        return { id, title: id, episodes: episodes.reverse() };
                    }
                }
            } catch(e) {}
        }
        throw new Error("Gogo Info Failed");
    }

    async fetchEpisodeSources(episodeId: string) {
        console.log(chalk.blue(`   -> Gogo: Fetching source for ${episodeId}...`));

        // 🟢 STRATEGY: PROXY ASSAULT
        // We will hit the download pages through our Shield Wall
        const downloadMirrors = [
            `https://anitaku.pe/download?id=${episodeId}`,
            `https://gogoanimes.fi/download?id=${episodeId}`,
            `https://gogohd.net/download?id=${episodeId}`
        ];

        for (const url of downloadMirrors) {
            console.log(chalk.gray(`      Trying download page via Shield: ${url}`));
            
            const html = await fetchShield(url);
            if (!html) continue;

            const $ = cheerio.load(html);
            let bestUrl = "";

            // Scan for MP4s (The "Golden" links)
            $('.mirror_link .dowload a, .dowload a').each((i, el) => {
                const href = $(el).attr('href');
                const text = $(el).text().trim().toUpperCase();
                
                if (href && (text.includes("DOWNLOAD") || text.includes("MP4") || text.includes("HDP"))) {
                    if (href.startsWith("http")) {
                        // Priority: 1080 > 720
                        if (!bestUrl || text.includes("1080")) {
                            bestUrl = href;
                        }
                    }
                }
            });

            if (bestUrl) {
                console.log(chalk.green(`      🎉 PROXY SUCCESS: ${bestUrl}`));
                // isM3U8: false (Direct MP4s play everywhere)
                return { sources: [{ url: bestUrl, quality: 'default', isM3U8: false }] };
            }
        }

        // 🟢 FALLBACK: If Proxy fails, try to return the raw Embed URL
        // Sometimes the frontend can play the iframe even if the backend can't scrape it
        const fallbackUrl = `https://embtaku.pro/streaming.php?id=${episodeId.split('-').pop()}`;
        console.log(chalk.yellow(`      ⚠️ Proxy scan failed. Returning raw embed: ${fallbackUrl}`));
        return { sources: [{ url: fallbackUrl, quality: 'iframe', isM3U8: false }] };
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
        if (url.includes('.php') || url.includes('.html')) return reply.status(400).send("Invalid Video");

        // Use Proxy Shield for the video playback too if needed
        const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
        const response = await fetch(proxyUrl);
        
        reply.header("Access-Control-Allow-Origin", "*");
        const buffer = await response.arrayBuffer();
        reply.send(Buffer.from(buffer));
    } catch (e) { reply.status(500).send({ error: "Proxy Error" }); }
  });
};

export default routes;