---
name: web-research
description: Research a topic on the internet and answer with sources.
when: The user asks for current facts, news, prices, or anything after your training data.
updatedAt: 2026-10-11T00:00:00.000Z
---

# Web research

1. Turn the question into a short search query (2–5 keywords).
2. Call `webSearch` with that query. Read the titles and snippets; pick the two
   or three most relevant results.
3. Call `webFetch` on the best result to read the page, and on a second source
   when the claim is important.
4. Answer in at most three sentences and list the URLs you used, one per line.
5. If the results disagree, say so and give both numbers instead of picking one.
6. If nothing useful comes back, say that plainly — never invent a source.
