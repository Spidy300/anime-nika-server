import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

const PROXIES = [
    "https://corsproxy.io/?",
    "https://api.codetabs.com/v1/proxy?quest=",
    "https://api.allorigins.win/raw?url="
];

// 🟢 BASE URL for your Render Server (Used for wrapping images)
const SERVER_URL = "https://anime-server-xzlh.onrender.com/anime/animepahe/proxy?url=";

async function fetchShield(targetUrl: string) {
    try {
        const res = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://gogoanimes.fi/',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        if (res.ok) return await res.text();
    } catch (e) {}

    for (const proxy of PROXIES) {
        try {
            const res = await fetch(`${proxy}${encodeURIComponent(targetUrl)}`);
            if (res.ok) {
                const text = await res.text();
                if (text.includes("<html") && text.length > 500) return text;
            }
        } catch (e) {}
    }
    return "";
}

class CustomGogo {
    mirrors = ["https://anitaku.pe", "https://gogoanimes.fi", "https://gogoanime3.co"];
    
    async search(query: string) {
        return this.internalSearch(query);
    }

    async internalSearch(query: string) {
        for (const domain of this.mirrors) {
            try {
                const searchUrl = `${domain}/search.html?keyword=${encodeURIComponent(query)}`;
                const html = await fetchShield(searchUrl);
                if (!html) continue;

                const $ = cheerio.load(html);
                const results: any[] = [];

                $('.last_episodes ul li').each((i, el) => {
                    const title = $(el).find('.name a').text().trim();
                    const link = $(el).find('.name a').attr('href');
                    let img = $(el).find('.img a img').attr('src');
                    const releaseDate = $(el).find('.released').text().trim();
                    
                    // 🟢 FIX: Proxy the Image URL
                    if (img) {
                        if (!img.startsWith('http')) img = `https://gogocdn.net${img}`;
                        // Wrap it in our proxy to bypass 403 Forbidden
                        img = `${SERVER_URL}${encodeURIComponent(img)}`;
                    }

                    if (title && link) {
                        results.push({
                            id: link.replace('/category/', '').trim(), 
                            title: title,
                            image: img,
                            releaseDate: releaseDate
                        });
                    }
                });

                if (results.length > 0) return { results };
            } catch (e) {}
        }
        return { results: [] };
    }

    async fetchAnimeInfo(id: string) {
        console.log(chalk.blue(`   -> Gogo: Hunting for info on ${id}...`));
        
        // Smart ID Cleaner
        let cleanId = id.replace(/-episode-\d+$/, '').replace(/-\d+$/, '');
        
        console.log(chalk.gray(`      Cleaning ID: ${id} -> ${cleanId}`));

        // Attempt 1: Direct Lookup
        let foundInfo = await this.scrapeInfoPage(cleanId);

        // Attempt 2: Search Fallback
        if (!foundInfo) {
            console.log(chalk.yellow(`      Direct lookup failed. Searching for "${cleanId}"...`));
            const searchData = await this.internalSearch(cleanId.replace(/-/g, " "));
            
            if (searchData.results && searchData.results.length > 0) {
                const bestMatch = searchData.results[0].id;
                console.log(chalk.green(`      🎉 Found via Search: ${bestMatch}`));
                foundInfo = await this.scrapeInfoPage(bestMatch);
            }
        }

        if (foundInfo) return foundInfo;
        throw new Error("Gogo Info Failed");
    }

    async scrapeInfoPage(id: string) {
        for (const domain of this.mirrors) {
            try {
                const html = await fetchShield(`${domain}/category/${id}`);
                if (!html || html.includes("404 Not Found") || !html.includes("anime_info_body_bg")) continue;

                const $ = cheerio.load(html);
                const movie_id = $('#movie_id').attr('value');
                const alias = $('#alias_anime').attr('value');
                const title = $('.anime_info_body_bg h1').text().trim();
                let image = $('.anime_info_body_bg img').attr('src');
                const desc = $('.anime_info_body_bg .description').text().trim();
                let ep_end = $('#episode_page a').last().attr('ep_end') || "2000";

                // 🟢 FIX: Proxy the Image URL
                if (image) {
                    if (!image.startsWith('http')) image = `https://gogocdn.net${image}`;
                    image = `${SERVER_URL}${encodeURIComponent(image)}`;
                }

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

                    return { 
                        id: id, 
                        title: title, 
                        image: image, 
                        description: desc,
                        episodes: episodes.reverse() 
                    };
                }
            } catch(e) {}
        }
        return null;
    }

    async fetchEpisodeSources(episodeId: string) {
        console.log(chalk.blue(`   -> Gogo: Fetching source for ${episodeId}...`));

        const downloadMirrors = [
            `https://anitaku.pe/download?id=${episodeId}`,
            `https://gogoanimes.fi/download?id=${episodeId}`,
            `https://gogohd.net/download?id=${episodeId}`
        ];

        for (const url of downloadMirrors) {
            console.log(chalk.gray(`      Trying download page: ${url}`));
            const html = await fetchShield(url);
            if (!html) continue;

            const $ = cheerio.load(html);
            let bestUrl = "";

            $('.mirror_link .dowload a, .dowload a').each((i, el) => {
                const href = $(el).attr('href');
                const text = $(el).text().trim().toUpperCase();
                
                if (href && (text.includes("DOWNLOAD") || text.includes("MP4") || text.includes("HDP"))) {
                    if (href.startsWith("http")) {
                        if (!bestUrl || text.includes("1080")) bestUrl = href;
                    }
                }
            });

            if (bestUrl) {
                console.log(chalk.green(`      🎉 PROXY SUCCESS: ${bestUrl}`));
                return { sources: [{ url: bestUrl, quality: 'default', isM3U8: false }] };
            }
        }

        const fallbackUrl = `https://embtaku.pro/streaming.php?id=${episodeId.split('-').pop()}`;
        console.log(chalk.yellow(`      ⚠️ Proxy scan failed. Returning fallback: ${fallbackUrl}`));
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

  // Default routes
  fastify.get('/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));

  fastify.get('/proxy', async (req: any, reply: FastifyReply) => {
    try {
        const { url } = req.query;
        if (!url) return reply.status(400).send("Missing URL");
        
        // Allow images to pass through
        if (url.includes('.php') || url.includes('.html')) return reply.status(400).send("Invalid Video");

        const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
        const response = await fetch(proxyUrl);
        
        reply.header("Access-Control-Allow-Origin", "*");
        const buffer = await response.arrayBuffer();
        reply.send(Buffer.from(buffer));
    } catch (e) { reply.status(500).send({ error: "Proxy Error" }); }
  });
};

export default routes;