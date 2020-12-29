import fetch from 'node-fetch';

const seedNodes: string[] = [
  'xenon.blockstack.org',
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

async function queryNodeNeighbors(nodeUrl: string, retries = 3): Promise<Set<string>> {
  const ips = new Set<string>();
  for (let i = 0; i < retries; i++) {
    try {
      const queryUrl = `http://${nodeUrl}:20443/v2/neighbors`;
      console.log(`Querying ${queryUrl}`);
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 1500);
      const req = await fetch(queryUrl, { signal: ac.signal as any });
      const result: Neighbors = await req.json();
      [...result.sample, ...result.inbound, ...result.outbound].forEach(n => ips.add(n.ip));
    } catch (error) {
      console.info(`Neighbors RPC failed for ${nodeUrl}: ${error.message}`);
      break;
      if (i < retries) {
        await wait(500);
      }
    }
  }
  console.log(`Node ${nodeUrl} has ${ips.size} neighbors`);
  return ips;
}

async function scanNeighbors() {
  const foundIps = new Set<string>();
  const queriedIps = new Set<string>();

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

  // let ipsToQuery = getIpsToQuery();
  let ipsToQuery: Set<string>;
  while ((ipsToQuery = getIpsToQuery()).size > 0) {
    for (const ip of ipsToQuery) {
      queriedIps.add(ip);
      const results = await queryNodeNeighbors(ip);
      results.forEach(n => foundIps.add(n));
    }
  }

  seedNodes.forEach(n => foundIps.delete(n));

  console.log(`Found ${foundIps.size} nodes:`);
  console.log([...foundIps]);

}

scanNeighbors().catch(error => {
  console.error(`Unexpected error during scan: ${error.message}`);
  console.error(error);
});
