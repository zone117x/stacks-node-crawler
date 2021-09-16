import fetch from 'node-fetch';
import pQueue from 'p-queue';
import * as geoipCountry from 'geoip-country';
import AbortController from "abort-controller";
import { Address4 } from 'ip-address';

const seedNodes: string[] = [
  'stacks-node-api.mainnet.stacks.co',
  'seed-0.mainnet.stacks.co:20443',
  'seed-1.mainnet.stacks.co:20443',
  'seed-2.mainnet.stacks.co:20443',
];

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/*
  "network_id": 1,
  "peer_version": 402653184,
  "ip": "50.17.99.78",
  "port": 20444,
  "public_key_hash": "2073870d87637302a3cabe39bc9682ddda836302",
  "authenticated": true
*/

type IPv4 = `${string}.${string}.${string}.${string}`;
type NeighborID = `${IPv4}@${string}`;

type NeighborMap = Map<NeighborID, Neighbor>;

interface Neighbor {
  network_id: number;
  peer_version: number;
  ip: IPv4;
  port: number;
  public_key_hash: string;
  authenticated: boolean;
}

interface Neighbors {
  sample: Neighbor[];
  inbound: Neighbor[];
  outbound: Neighbor[];
}

interface QueryResult {
  responsive: boolean;
  neighbors: Set<string>;
  uniqueNeighbors: NeighborMap;
}

const RPC_PORT = 20443;

function getQueryUrls(nodeUrl: string): string[] {
  return [...new Set([
    nodeUrl,
    `${nodeUrl}:${RPC_PORT}`
  ])];
}

async function queryNodeNeighbors(nodeUrl: string, retries = 16): Promise<QueryResult> {
  const ips = new Set<string>();
  const uniqueNeighbors = new Map<NeighborID, Neighbor>();
  let responsive = false;
  for (const queryUrl of getQueryUrls(nodeUrl)) {
    for (let i = 0; i < retries; i++) {
      try {
        const queryNeighborsUrl = `http://${queryUrl}/v2/neighbors`;
        console.log(`Querying ${queryNeighborsUrl}`);
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 15000);
        const req = await fetch(queryNeighborsUrl, { signal: ac.signal as any });
        const result = await req.json() as Neighbors;
        responsive = true;
        const allNeighbors = [...result.sample, ...result.inbound, ...result.outbound];
        allNeighbors.forEach(n => ips.add(n.ip));
        allNeighbors.forEach(n => uniqueNeighbors.set(`${n.ip}@${n.public_key_hash}`, n));
      } catch (error) {
        console.info(`Neighbors RPC failed for ${nodeUrl}: ${(error as Error).message}`);
        if (i < retries) {
          await wait(1500);
        }
      }
    }
  }
  console.log(`Node ${nodeUrl} has ${ips.size} neighbors`);
  return { neighbors: ips, responsive, uniqueNeighbors };
}

async function scanNeighbors() {
  const uniqueNeighbors = new Map<string, Neighbor>();
  const foundIps = new Set<string>();
  const responsiveIps = new Set<string>();
  const queriedIps = new Set<string>();

  const requestQueue = new pQueue({concurrency: 50});

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
        result.uniqueNeighbors.forEach((v, k) => {
          if (!uniqueNeighbors.has(k)) {
            console.log(`Found unique neighbor: ${k}`);
            uniqueNeighbors.set(k, v);
          }
        });
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
  foundIps.delete('0.0.0.0');

  uniqueNeighbors.forEach((n, key) => {
    if (BigInt('0x' + n.public_key_hash) === 0n || n.ip === '0.0.0.0') {
      uniqueNeighbors.forEach((n1, k1) => {
        if (n1.ip === n.ip && k1 !== key) {
          uniqueNeighbors.delete(k1);
        }
      });
    }
  });

  const ipSubnetClassA = new Address4('10.0.0.0/8');
  const ipSubnetClassB = new Address4('172.16.0.0/12');
  const ipSubnetClassC = new Address4('192.168.0.0/16');
  const privateIps = [...foundIps]
    .map(ip => new Address4(ip))
    .filter(ip => ip.isInSubnet(ipSubnetClassA) || ip.isInSubnet(ipSubnetClassB) || ip.isInSubnet(ipSubnetClassC))
    .map(ip => ip.address);

  const publicIps = [...foundIps].filter(ip => !privateIps.includes(ip));

  console.log('-------');
  console.log('Neighbors:');
  console.log([...uniqueNeighbors.keys()].sort().join('\n'));
  console.log('-------');
  console.log('Public nodes:');
  console.log([...responsiveIps].sort().join('\n'));
  console.log('-------');
  console.log(`Found ${uniqueNeighbors.size} nodes (${privateIps.length} with private IPs, ${publicIps.length} with public IPs, ${responsiveIps.size} with public RPC)`);

  const countries = new Map<string, number>();
  uniqueNeighbors.forEach(n => {
    const result = geoipCountry.lookup(n.ip)
    const country = result?.country ?? 'Private';
    let count = countries.get(country) ?? 0;
    countries.set(country, ++count);
  });

  const countryEntries = [...countries.entries()].sort((a, b) => b[1] - a[1]);
  const countrySummary = countryEntries.map(e => `${e[0]}: ${e[1]}`).join(', ');
  console.log(`Results by country:`);
  console.log(countrySummary);
}

scanNeighbors().catch(error => {
  console.error(`Unexpected error during scan: ${error.message}`);
  console.error(error);
});
