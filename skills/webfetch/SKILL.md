---
name: webfetch
description: Fetch and extract text content from web URLs. Returns title, metadata, and main content.
---

# Web Fetch Skill

Fetch web pages and extract readable content. No browser required - uses native fetch and text extraction.

## When to use
- Reading documentation from URLs
- Extracting article content
- Fetching API responses
- Reading raw web content

## Usage

### Basic fetch
```bash
# Fetch raw content
curl -s "https://example.com/article" -H "User-Agent: Mozilla/5.0"
```

### Node.js
```javascript
async function webFetch(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);
  
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PicordBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...options.headers
      }
    });
    
    clearTimeout(timeout);
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    
    const contentType = res.headers.get('content-type') || '';
    
    // Handle JSON responses
    if (contentType.includes('application/json')) {
      return { type: 'json', data: await res.json() };
    }
    
    // Handle HTML responses
    if (contentType.includes('text/html')) {
      const html = await res.text();
      return extractHtmlContent(html, url);
    }
    
    // Handle plain text
    return { type: 'text', content: await res.text(), url };
    
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

function extractHtmlContent(html, url) {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  
  // Extract meta description
  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
  const description = descMatch ? descMatch[1] : '';
  
  // Extract main content (simple extraction)
  // Remove scripts, styles, nav, footer, header
  let content = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  
  // Try to find main content area
  const mainMatch = content.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
                    content.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
                    content.match(/<div[^>]*class=["'][^"']*content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  
  if (mainMatch) {
    content = mainMatch[1];
  }
  
  // Strip remaining HTML tags and decode entities
  content = content
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  
  // Truncate if too long (keep first ~50KB of text)
  if (content.length > 50000) {
    content = content.substring(0, 50000) + '\n\n[Content truncated...]';
  }
  
  return {
    type: 'html',
    url,
    title,
    description,
    content,
    length: content.length
  };
}

// Usage:
// webFetch('https://docs.example.com/api').then(console.log);
```

## Error handling
```javascript
async function safeWebFetch(url) {
  try {
    return await webFetch(url);
  } catch (err) {
    if (err.name === 'AbortError') {
      return { error: 'Request timed out', url };
    }
    if (err.message.includes('HTTP 403')) {
      return { error: 'Access denied (403)', url };
    }
    if (err.message.includes('HTTP 404')) {
      return { error: 'Page not found (404)', url };
    }
    return { error: err.message, url };
  }
}
```

## Rate limiting
```javascript
// Simple rate limiter
const fetchQueue = [];
let lastFetch = 0;
const MIN_INTERVAL = 1000; // 1 second between requests

async function rateLimitedFetch(url) {
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL - (now - lastFetch));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastFetch = Date.now();
  return webFetch(url);
}
```

## Agent prompt
```text
You have a webfetch skill. Use it to read content from URLs.

To fetch:
1. Use fetch(url) with appropriate headers
2. Check content-type header
3. For HTML: extract title, description, and main text content
4. For JSON: parse and return the data object
5. For text: return raw content

Handle errors gracefully:
- 403: access denied
- 404: not found
- Timeout: use 10-15 second timeout

Respect rate limits - wait 1 second between requests to same domain.
```

## Best practices
- Set reasonable timeouts (10-15 seconds)
- Include User-Agent header
- Handle content-type appropriately
- Truncate large responses
- Wait between requests to same domain
- Check for and respect robots.txt when scraping

## Limitations
- Cannot execute JavaScript
- Cannot handle authenticated pages
- Cannot bypass paywalls
- Single-page fetch only (no crawling)
