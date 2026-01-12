import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

const PROXY_URL = "https://anime-proxyc.sudeepb9880.workers.dev"; 

// 🟢 MOBILE HEADERS: Triggers simple HTML on Gogoanime
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

async function fetchShield(targetUrl: string, referer?: string) {
    let fullUrl = `${PROXY_URL}?url=${encodeURIComponent(targetUrl)}`;
    
    // Add fake mobile headers
    fullUrl += `&headers=${encodeURIComponent(JSON.stringify({
        'User-Agent': MOBILE_UA,
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
    // 🟢 UPDATED MIRRORS: Use the freshest domains
    mirrors = ["https://anitaku.pe", "https://anitaku.so", "https://gogoanimes.fi"];
    
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

        // 🟢 STRATEGY 1: CONSTRUCT DOWNLOAD PAGE (MOBILE MODE)
        // We use the mobile user agent to try and get a cleaner page
        const downloadMirrors = [
            `https://anitaku.so/download?id=${episodeId}`,
            `https://gogohd.net/download?id=${episodeId}`,
            `https://goload.io/download?id=${episodeId}`
        ];

        for (const url of downloadMirrors) {
            try {
                console.log(chalk.gray(`      [Mobile] Trying download page: ${url}`));
                const html = await fetchShield(url, "https://anitaku.so/"); // Fake referer
                const $ = cheerio.load(html);
                
                let bestUrl = "";
                
                // Loose search for MP4 links
                $('a').each((i, el) => {
                    const href = $(el).attr('href');
                    const text = $(el).text().toUpperCase();
                    
                    if (href && (text.includes("DOWNLOAD") || text.includes("MP4") || text.includes("HDP"))) {
                        // Avoid junk links
                        if (href.includes('facebook') || href.includes('twitter')) return;
                        
                        if (!bestUrl || text.includes("1080")) bestUrl = href;
                    }
                });

                if (bestUrl) {
                    console.log(chalk.green(`      🎉 EXTRACTED MP4: ${bestUrl}`));
                    return { sources: [{ url: bestUrl, quality: 'default', isM3U8: false }] };
                }
            } catch (e) {}
        }

        // 🟢 STRATEGY 2: IFRAME DEEP SCAN (MOBILE MODE)
        console.log(chalk.gray("      Falling back to Iframe Scan..."));
        
        // We need to fetch the episode page first to find the iframe
        for (const domain of this.mirrors) {
            try {
                const epHtml = await fetchShield(`${domain}/${episodeId}`);
                const $ = cheerio.load(epHtml);
                
                let iframe = $('iframe').first().attr('src');
                // Try to find the 'vidcdn' specific iframe
                const vidcdn = $('li.vidcdn a').attr('data-video');
                if (vidcdn) iframe = vidcdn;

                if (iframe) {
                    if (iframe.startsWith('//')) iframe = 'https:' + iframe;
                    console.log(chalk.gray(`      Scanning Player: ${iframe}`));
                    
                    const playerHtml = await fetchShield(iframe, domain);
                    
                    // Regex for M3U8 (Standard)
                    const m3u8Match = playerHtml.match(/(https?:\/\/[^"']+\.m3u8[^"']*)/);
                    if (m3u8Match && m3u8Match[1]) {
                        console.log(chalk.green(`      🎉 EXTRACTED M3U8: ${m3u8Match[1]}`));
                        return { sources: [{ url: m3u8Match[1], quality: 'default', isM3U8: true }] };
                    }
                    
                    // Regex for JwPlayer Sources (Often used in mobile view)
                    const sourceMatch = playerHtml.match(/sources:\s*\[\s*\{.*?file:\s*['"]([^'"]+)['"]/s);
                    if (sourceMatch && sourceMatch[1]) {
                         console.log(chalk.green(`      🎉 EXTRACTED JWPLAYER: ${sourceMatch[1]}`));
                         return { sources: [{ url: sourceMatch[1], quality: 'default', isM3U8: sourceMatch[1].includes('.m3u8') }] };
                    }
                }
            } catch (e) {}
        }

        throw new Error("Gogo Watch Failed - All strategies exhausted");
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

  // Catch-all
  fastify.get('/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));

  fastify.get('/proxy', async (req: any, reply: FastifyReply) => {
    try {
        const { url } = req.query;
        if (!url) return reply.status(400).send("Missing URL");
        const fullUrl = `${PROXY_URL}?url=${encodeURIComponent(url)}`;
        const response = await fetch(fullUrl);
        reply.header("Access-Control-Allow-Origin", "*");
        reply.send(Buffer.from(await response.arrayBuffer()));
    } catch (e) { reply.status(500).send({ error: "Proxy Error" }); }
  });
};

export default routes;