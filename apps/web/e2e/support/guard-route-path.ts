/** Existing-resource guards also need concrete addresses when testing missing resources. */
const routeParameters: Readonly<Record<string, string>> = {
  batchId: '00000000-0000-4000-8000-000000000271',
  rowId: '00000000-0000-4000-8000-000000000272',
  groupId: '00000000-0000-4000-8000-000000000273',
  assetId: '00000000-0000-4000-8000-000000000274',
  campaignId: '00000000-0000-4000-8000-000000000275',
};

export function guardRoutePath(template: string): string {
  return template.replace(/\[([^\]]+)\]/g, (_segment, parameter: string) => {
    const value = routeParameters[parameter];
    if (value === undefined) throw new Error(`Guard route parameter requires a synthetic value: ${parameter}`);
    return value;
  });
}
