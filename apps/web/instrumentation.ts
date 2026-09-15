/** Remove OAuth query credentials before Next creates request logs or spans. */
export async function register() {
  if (process.env['NEXT_RUNTIME'] === 'nodejs') {
    const { installOAuthQueryCustody } = await import('./src/oauth/request-custody');
    installOAuthQueryCustody();
  }
}
