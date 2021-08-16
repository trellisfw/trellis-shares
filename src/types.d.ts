declare module '@trellisfw/masklink' {
  async function maskAndSignRemoteResourceAsNewResource(args: {
    url: string;
    paths: readonly string[];
    token?: string;
    signer: { name: string; url: string };
    privateJWK: object;
  }): Promise<string>;
  function findAllMaskPathsInResource(resource: object): string[];
}
