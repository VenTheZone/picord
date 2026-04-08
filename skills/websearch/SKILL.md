---
name: websearch
description: Search the web using free SearXNG API. No API keys required. Returns search results with titles, URLs, and snippets.
---

# Web Search Skill

Search the web using free SearXNG instances. No API keys, no rate limits, no costs.

## When to use
- Finding current information on any topic
- Researching documentation, articles, or news
- Looking up API references or tutorials
- Finding solutions to errors or problems

## Usage

### Basic search
```bash
# Search using curl
curl -s "https://searx.party/search?q=your+query&format=json&language=en" | jq '.results[] | {title, url, content}'
```

### Node.js
```javascript
async function webSearch(query, options = {}) {
  const instances = [
    'https://searx.party',
    'https://searx.tiekoetter.com',
    'https://searx.be'
  ];
  
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    language: options.language || 'en',
    safesearch: options.safesearch ?? 0,
    categories: options.categories || 'general'
  });
  
  for (const instance of instances) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      const res = await fetch(`${instance}/search?${params}`, {
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (!res.ok) continue;
      const data = await res.json();
      
      if (data.results?.length > 0) {
        return data.results.map(r => ({
          title: r.title,
          url: r.url,
          snippet: r.content,
          engine: r.engine
        }));
      }
    } catch {
      continue;
    }
  }
  
  throw new Error('All search instances failed');
}

// Usage:
// webSearch('node.js best practices 2024').then(console.log);
```

## Categories
- `general` — default web search
- `news` — news articles
- `images` — image search
- `videos` — video search
- `science` — scientific papers
- `it` — IT/tech resources

## Time ranges
Add `time_range` parameter:
- `day` — last 24 hours
- `week` — last 7 days
- `month` — last 30 days
- `year` — last year

```javascript
// Recent news example
const params = new URLSearchParams({
  q: 'AI developments',
  format: 'json',
  categories: 'news',
  time_range: 'week'
});
```

## Agent prompt
```text
You have a websearch skill. Use it to find current information when needed.

To search:
1. Use fetch() to GET https://searx.party/search?q={query}&format=json&language=en
2. Parse JSON response
3. Results contain: title, url, content (snippet), engine

For recent results, add &time_range=week or &categories=news

Always cite sources when using search results.
```

## Best practices
- Use specific queries for better results
- Add `&language=en` for English results
- Use categories to filter results
- Check multiple instances if one fails
- Set 10 second timeout for requests
