import fetch from 'node-fetch';
import pQueue from 'p-queue';
import * as geoipCountry from 'geoip-country';
import AbortController from "abort-controller";

const seedNodes: string[] = [
  'stacks-node-api.mainnet.stacks.co',
  'seed-0.mainnet.stacks.co:20443',
  'seed-1.mainnet.stacks.co:20443',
  'seed-2.mainnet.stacks.co:20443',
];

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface Neighbor {
  ip: string;
}

interface Neighbors {
  sample: Neighbor[];
  inbound: Neighbor[];
  outbound: Neighbor[];
}

interface QueryResult {
  responsive: boolean;
  neighbors: Set<string>;
}

const RPC_PORT = 20443;

function getQueryUrls(nodeUrl: string): string[] {
  return [...new Set([
    nodeUrl,
    `${nodeUrl}:${RPC_PORT}`
  ])];
}

async function queryNodeNeighbors(nodeUrl: string, retries = 8): Promise<QueryResult> {
  const ips = new Set<string>();
  let responsive = false;
  for (const queryUrl of getQueryUrls(nodeUrl)) {
    for (let i = 0; i < retries; i++) {
      try {
        const queryNeighborsUrl = `http://${queryUrl}/v2/neighbors`;
        console.log(`Querying ${queryNeighborsUrl}`);
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 15000);
        const req = await fetch(queryNeighborsUrl, { signal: ac.signal as any });
        const result: Neighbors = await req.json();
        responsive = true;
        [...result.sample, ...result.inbound, ...result.outbound].forEach(n => ips.add(n.ip));
      } catch (error) {
        console.info(`Neighbors RPC failed for ${nodeUrl}: ${error.message}`);
        if (i < retries) {
          await wait(1500);
        }
      }
    }
  }
  console.log(`Node ${nodeUrl} has ${ips.size} neighbors`);
  return { neighbors: ips, responsive };
}

async function scanNeighbors() {
  const foundIps = new Set<string>();
  const responsiveIps = new Set<string>();
  const queriedIps = new Set<string>();

  const requestQueue = new pQueue({concurrency: 250});

  const getIpsToQuery = () => {
    const ips = new Set<string>();
    foundIps.forEach(ip => {
      if (!queriedIps.has(ip)) {
        ips.add(ip);
      }
    });
    return ips;
  };

  seedNodes.forEach(n => foundIps.add(n));

  const queueQueries = () => {
    getIpsToQuery().forEach(ip => {
      queriedIps.add(ip);
      requestQueue.add(async () => {
        const result = await queryNodeNeighbors(ip);
        if (result.responsive) {
          responsiveIps.add(ip);
        }
        result.neighbors.forEach(n => foundIps.add(n));
        queueQueries();
      });
    });
  };

  queueQueries();

  await requestQueue.onIdle();

  seedNodes.map(n => getQueryUrls(n)).flat().forEach(n => {
    foundIps.delete(n);
    responsiveIps.delete(n);
  });

  console.log('-------');
  console.log('IPs:');  
  console.log(`Total nodes:\n${[...responsiveIps].sort().join('\n')}`);
  console.log([...foundIps].sort().join('\n'));
  console.log('Public nodes:');
  console.log([...responsiveIps].sort().join('\n'));
  console.log(`Found ${foundIps.size} nodes, ${responsiveIps.size} with public RPC`);

  const countries = new Map<string, number>();
  foundIps.forEach(ip => {
    const result = geoipCountry.lookup(ip)
    const country = result?.country ?? '??';
    let count = countries.get(country) ?? 0;
    countries.set(country, ++count);
  });

  const countryEntries = [...countries.entries()].sort((a, b) => b[1] - a[1]);
  const countrySummary = countryEntries.map(e => `${e[0]} ${e[1]}`).join(', ');
  console.log(`Results by country:\nCountry, Node Count`);
  console.log(countrySummary);
}

scanNeighbors().catch(error => {
  console.error(`Unexpected error during scan: ${error.message}`);
  console.error(error);
});
