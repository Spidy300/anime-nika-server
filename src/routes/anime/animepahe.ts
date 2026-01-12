import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

// 🟢 THE PROXY ARSENAL
// We use these services to hide your Render IP from Gogoanime
const PROXY_GATES = [
    "https://corsproxy.io/?", 
    "https://api.allorigins.win/raw?url=",
    "https://api.codetabs.com/v1/proxy?quest="
];

async function fetchShield(targetUrl: string) {
    // We try every proxy until one works
    for (const proxy of PROXY_GATES) {
        try {
            const fullUrl = `${proxy}${encodeURIComponent(targetUrl)}`;
            // console.log(chalk.gray(`      🛡️ Tunneling: ${proxy} -> ${targetUrl}`));
            
            const res = await fetch(fullUrl, {
                headers: {
                    // Fake a generic Chrome browser
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });
            
            if (res.ok) {
                const text = await res.text();
                // Simple check to ensure we didn't get a captcha page
                if (text.includes("<html") && text.length > 500) return text;
            }
        } catch (e) {}
    }
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
        
        // Try direct connection first for Info (usually not blocked as heavily)
        for (const domain of this.mirrors) {
            try {
                const res = await fetch(`${domain}/category/${id}`);
                if (!res.ok) continue;
                const html = await res.text();
                
                const $ = cheerio.load(html);
                const movie_id = $('#movie_id').attr('value');
                const alias = $('#alias_anime').attr('value');
                let ep_end = $('#episode_page a').last().attr('ep_end') || "2000";

                if (movie_id) {
                    console.log(chalk.green(`      ✅ Found movie_id: ${movie_id} on ${domain}`));
                    
                    // Ajax load list
                    const ajaxUrl = `https://ajax.gogo-load.com/ajax/load-list-episode?ep_start=0&ep_end=${ep_end}&id=${movie_id}&default_ep=0&alias=${alias}`;
                    const listRes = await fetch(ajaxUrl);
                    const listHtml = await listRes.text();
                    
                    const $ep = cheerio.load(listHtml);
                    const episodes: any[] = [];
                    
                    $ep('li').each((i, el) => {
                        let epId = $ep(el).find('a').attr('href')?.trim() || "";
                        epId = epId.replace(/^\//, ''); // Remove leading slash
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

        // 🟢 STRATEGY: PROXY DOWNLOAD PAGE ATTACK
        // We do not guess. We force-visit the download mirrors via Proxy.
        const downloadMirrors = [
            `https://anitaku.pe/download?id=${episodeId}`,
            `https://gogoanimes.fi/download?id=${episodeId}`,
            `https://gogohd.net/download?id=${episodeId}`
        ];

        for (const url of downloadMirrors) {
            console.log(chalk.gray(`      Trying download page: ${url}`));
            
            // Use the Proxy Tunnel
            const html = await fetchShield(url);
            
            if (!html) continue;

            const $ = cheerio.load(html);
            let bestUrl = "";

            // Scan for MP4s (Reliable, Unencrypted)
            $('.mirror_link .dowload a, .dowload a').each((i, el) => {
                const href = $(el).attr('href');
                const text = $(el).text().trim().toUpperCase();
                
                // We are looking for "1080P", "720P", or "HDP"
                if (href && (text.includes("1080") || text.includes("720") || text.includes("360") || text.includes("HDP"))) {
                    // Ensure it's a valid link
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
                // isM3U8: false (Because it's an MP4)
                return { sources: [{ url: bestUrl, quality: 'default', isM3U8: false }] };
            }
        }

        // 🔴 FAILSAFE: Return the embedded player URL as a fallback
        // If we can't find an MP4, give the frontend the iframe. 
        // Some frontends can handle iframes automatically.
        const fallbackUrl = `https://embtaku.pro/streaming.php?id=${episodeId.split('-').pop()}`;
        console.log(chalk.yellow(`      ⚠️ Extraction failed. Returning fallback embed: ${fallbackUrl}`));
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
        
        // 🟢 PROXY TUNNEL FOR PLAYBACK
        // If the frontend tries to play the file, we tunnel that too
        const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
        const response = await fetch(proxyUrl);
        
        reply.header("Access-Control-Allow-Origin", "*");
        // Stream the data back
        const buffer = await response.arrayBuffer();
        reply.send(Buffer.from(buffer));
        
    } catch (e) { reply.status(500).send({ error: "Proxy Error" }); }
  });
};

export default routes;