// scripts/find-lists.mjs
import dotenv from 'dotenv';
import fs from 'fs';

// Explicitly load .env.local
dotenv.config({ path: '.env.local' });

const token = process.env.HUBSPOT_ACCESS_TOKEN;

if (!token) {
  console.error('❌ Error: Could not find HUBSPOT_ACCESS_TOKEN in .env.local');
  process.exit(1);
}

async function dumpAllLists() {
  console.log('Fetching all HubSpot lists into lists-catalog.json...\n');
  try {
    let allLists = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const res = await fetch('https://api.hubapi.com/crm/v3/lists/search', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: '',
          count: 100,
          offset: offset,
        }),
      });

      if (!res.ok) {
        throw new Error(`HubSpot API returned HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();
      const lists = data.lists || [];
      allLists.push(
        ...lists.map((l) => ({
          id: l.listId,
          name: l.name,
          size: l.additionalProperties?.hs_list_size ?? 0,
        }))
      );

      offset += 100;
      hasMore = data.hasMore && allLists.length < 500;
    }

    fs.writeFileSync('lists-catalog.json', JSON.stringify(allLists, null, 2));
    console.log(`✅ Success! Saved ${allLists.length} lists to lists-catalog.json`);
  } catch (err) {
    console.error('Execution failed:', err.message);
  }
}

dumpAllLists();