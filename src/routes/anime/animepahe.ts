import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

// 🟢 PUBLIC PROXIES (For Local Scrape)
const PROXIES = [
    "https://corsproxy.io/?",
    "https://api.codetabs.com/v1/proxy?quest=",
    "https://api.allorigins.win/raw?url="
];

async function fetchShield(targetUrl: string) {
    try {
        const res = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://gogoanimes.fi/',
            }
        });
        if (res.ok) return await res.text();
    } catch (e) {}

    for (const proxy of PROXIES) {
        try {
            const res = await fetch(`${proxy}${encodeURIComponent(targetUrl)}`);
            if (res.ok) {
                const text = await res.text();
                if (text && text.length > 500) return text;
            }
        } catch (e) {}
    }
    return "";
}

class CustomGogo {
    mirrors = ["https://anitaku.pe", "https://gogoanimes.fi", "https://gogoanime3.co"];

    async search(query: string) { return this.internalSearch(query); }

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
                    if (img && !img.startsWith('http')) img = `https://gogocdn.net${img}`;
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
        let cleanId = id.replace(/-episode-\d+$/, '').replace(/-\d+$/, '');
        console.log(chalk.gray(`      Cleaning ID: ${id} -> ${cleanId}`));

        let foundInfo = await this.scrapeInfoPage(cleanId);
        if (!foundInfo && cleanId !== id) foundInfo = await this.scrapeInfoPage(id);
        
        if (!foundInfo) {
            console.log(chalk.yellow(`      Direct lookups failed. Searching...`));
            const searchData = await this.internalSearch(cleanId.replace(/-/g, " "));
            if (searchData.results && searchData.results.length > 0) {
                foundInfo = await this.scrapeInfoPage(searchData.results[0].id);
            }
        }
        if (foundInfo) return foundInfo;
        throw new Error("Gogo Info Failed");
    }

    async scrapeInfoPage(id: string) {
        for (const domain of this.mirrors) {
            try {
                const html = await fetchShield(`${domain}/category/${id}`);
                if (!html || html.includes("404 Not Found")) continue;
                const $ = cheerio.load(html);
                const movie_id = $('#movie_id').attr('value');
                const alias = $('#alias_anime').attr('value');
                const title = $('.anime_info_body_bg h1').text().trim();
                let image = $('.anime_info_body_bg img').attr('src');
                const desc = $('.anime_info_body_bg .description').text().trim();
                let ep_end = $('#episode_page a').last().attr('ep_end') || "2000";

                if (image && !image.startsWith('http')) image = `https://gogocdn.net${image}`;

                if (movie_id) {
                    console.log(chalk.green(`      ✅ Found movie_id: ${movie_id}`));
                    const ajaxDomains = [`${domain}/ajax`, "https://ajax.gogo-load.com/ajax", "https://ajax.gogocdn.net/ajax"];
                    let listHtml = "";
                    for (const ajaxBase of ajaxDomains) {
                        const ajaxUrl = `${ajaxBase}/load-list-episode?ep_start=0&ep_end=${ep_end}&id=${movie_id}&default_ep=0&alias=${alias}`;
                        listHtml = await fetchShield(ajaxUrl);
                        if (listHtml) break;
                    }

                    if (listHtml) {
                        const $ep = cheerio.load(listHtml);
                        const episodes: any[] = [];
                        $ep('li').each((i, el) => {
                            let epId = $ep(el).find('a').attr('href')?.trim() || "";
                            epId = epId.replace(/^\//, ''); 
                            const epNum = $ep(el).find('.name').text().replace('EP ', '').trim();
                            if (epId) episodes.push({ id: epId, number: Number(epNum) });
                        });
                        return { id, title, image, description: desc, episodes: episodes.reverse() };
                    }
                }
            } catch(e) {}
        }
        return null;
    }

    async fetchEpisodeSources(episodeId: string) {
        console.log(chalk.blue(`   -> Gogo: Fetching source for ${episodeId}...`));

        // 1. LOCAL SCRAPE (Best Quality)
        for (const domain of this.mirrors) {
            try {
                const html = await fetchShield(`${domain}/${episodeId}`);
                if (!html) continue;
                const $ = cheerio.load(html);

                let downloadLink = $('.dowload a').attr('href');
                if (downloadLink && downloadLink.includes('.mp4')) {
                     console.log(chalk.green(`      🎉 FOUND MP4: ${downloadLink}`));
                     return { sources: [{ url: downloadLink, quality: 'default', isM3U8: false }] };
                }
                
                // Embed Extraction
                let embedUrl = $('iframe').first().attr('src') || $('.anime_muti_link ul li.vidcdn a').attr('data-video');
                if (embedUrl) {
                    if (embedUrl.startsWith('//')) embedUrl = `https:${embedUrl}`;
                    const playerHtml = await fetchShield(embedUrl);
                    const m3u8Match = playerHtml.match(/file:\s*['"](https?:\/\/[^"']+\.m3u8[^"']*)['"]/);
                    if (m3u8Match && m3u8Match[1]) {
                        console.log(chalk.green(`      🎉 EXTRACTED M3U8: ${m3u8Match[1]}`));
                        return { sources: [{ url: m3u8Match[1], quality: 'default', isM3U8: true }] };
                    }
                }
            } catch(e) {}
        }

        // 🟢 2. HYDRA BACKUP SYSTEM (Try 3 APIs in order)
        const BACKUP_APIS = [
            `https://consumet-api-drab.vercel.app/anime/gogoanime/watch/${episodeId}`, // Backup 1 (Consumet Mirror)
            `https://api.amvstr.me/api/v2/stream/${episodeId}`,                       // Backup 2 (AmvStr)
            `https://api.consumet.org/anime/gogoanime/watch/${episodeId}`             // Backup 3 (Original)
        ];

        console.log(chalk.yellow(`      ⚠️ Local scrape failed. Engaging Hydra Backups...`));

        for (const apiUrl of BACKUP_APIS) {
            try {
                console.log(chalk.gray(`      Trying API: ${apiUrl}`));
                const res = await fetch(apiUrl, { 
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } // Fake browser
                });
                
                if (!res.ok) continue;

                const data = await res.json() as any;
                let finalUrl = "";

                // Handle Different API Formats
                if (data.sources) {
                    // Consumet Format
                    const best = data.sources.find((s:any) => s.quality === 'default' || s.quality === '1080p') || data.sources[0];
                    if (best) finalUrl = best.url;
                } else if (data.stream && data.stream.multi && data.stream.multi.main) {
                    // AmvStr Format
                    finalUrl = data.stream.multi.main.url;
                }

                if (finalUrl) {
                    console.log(chalk.green(`      🎉 HYDRA SUCCESS: ${finalUrl}`));
                    return { sources: [{ url: finalUrl, quality: 'default', isM3U8: true }] };
                }
            } catch(e) {
                console.log(chalk.red(`      API Failed: ${e}`));
            }
        }

        // Final Fallback
        const fallbackUrl = `https://embtaku.pro/streaming.php?id=${episodeId.split('-').pop()}`;
        return { sources: [{ url: fallbackUrl, quality: 'iframe', isM3U8: false }] };
    }
}

const customGogo = new CustomGogo();

const routes = async (fastify: FastifyInstance, options: any) => {
  const safeRun = async (providerName: string, fn: () => Promise<any>, reply: any) => {
    try {
        const res = await fn();
        return reply.send(res);
    } catch (e: any) {
        return reply.status(200).send({ error: e.message, results: [] });
    }
  };
  fastify.get('/gogo/search/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/gogo/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/gogo/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));
  
  fastify.get('/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));

  fastify.get('/proxy', async (req: any, reply: FastifyReply) => {
    try {
        const { url } = req.query;
        if (!url) return reply.status(400).send("Missing URL");
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