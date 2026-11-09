// Governance history is intentionally undeletable. Keep fixtures until the
// owning disposable database is dropped by the verification harness. Never
// disable triggers or weaken FKs for test cleanup.
export async function removeTestOrganizations(prisma) {
  const [resource] = await prisma.$queryRaw`SELECT current_database() AS name`;
  if (!/^outpost_t04c_[a-f0-9]+$/.test(resource.name)) throw new Error('Fixtures require a newly provisioned disposable review database');
}
