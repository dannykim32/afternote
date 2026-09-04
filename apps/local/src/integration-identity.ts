export async function integrationIdentityIsHealthy(
  probe: () => boolean | Promise<boolean>,
): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
  }
}
