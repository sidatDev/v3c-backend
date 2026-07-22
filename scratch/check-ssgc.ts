import prisma from '../src/lib/prisma';

async function main() {
  const agent = await prisma.agent.findFirst({
    where: { name: { contains: 'Sui Southern' } }
  });
  console.log('Sui Southern Agent Details:', JSON.stringify(agent, null, 2));
}

main().catch(e => console.error(e));
