import type { ProductEvidence } from '@wizard-ads/shared';

export interface CatalogueProductsData {
  products: ProductEvidence[]; missingScopeAsins: string[]; advertisedIdentities: number; scopedRows: number; truncated: boolean;
}
export function listingState(product:ProductEvidence) {
  const row=product.metadata;
  if(product.metadataAvailability==='stale') return 'stale';
  if(!row || product.metadataAvailability==='missing') return 'missing';
  return [row.title,row.price,row.availability,row.bestSellerRank].every(field=>field.state==='returned') && product.metadataAvailability==='measured'?'measured':'partial';
}
export function CatalogueProducts({data}:{data:CatalogueProductsData}) {
  return <section aria-label="Current catalogue facts" style={{padding:'1rem',overflowX:'auto'}}>
    <h2>Current catalogue facts</h2>
    <p>{data.advertisedIdentities} advertised identities · {data.scopedRows} scoped rows. Current observations do not fill historical gaps.</p>
    {data.truncated?<p>Showing the first 300 advertised identities. Narrow the ASIN filter to inspect the remainder.</p>:null}
    {data.products.length===0 && data.missingScopeAsins.length===0?<p>No advertised ASINs in this scope.</p>:null}
    <table><thead><tr><th>ASIN</th><th>Marketplace</th><th>Evidence</th><th>Title</th><th>Price</th><th>Availability</th><th>BSR</th><th>Source and observation</th></tr></thead><tbody>
      {data.products.map((product,index)=>{const row=product.metadata;return <tr key={`${product.scope.marketplaceId}:${product.asin}:${index}`} data-testid="catalogue-product-row">
        <td>{product.asin}</td><td>{product.scope.marketplaceId}</td><td>{listingState(product)}</td>
        <td>{row?.title.state==='returned'?row.title.value:'Unavailable'}</td>
        <td>{row?.price.state==='returned'?`${row.price.value.amount} ${row.price.value.currency}`:'Unavailable'}</td>
        <td>{row?.availability.state==='returned'?row.availability.value:'Unavailable'}</td>
        <td>{row?.bestSellerRank.state==='returned'?row.bestSellerRank.value:'Unavailable'}</td>
        <td>Amazon Product Metadata v1{row?<> · acquired {row.provenance.acquiredAt} · retrieved {row.provenance.retrievedAt} · provider observed {row.provenance.providerObservedAt??'Unavailable'}</>:' · no observation'}</td>
      </tr>;})}
      {data.missingScopeAsins.map((asin,index)=><tr key={`${asin}:${index}`} data-testid="catalogue-product-row"><td>{asin}</td><td>Marketplace unavailable</td><td>missing</td><td colSpan={5}>No scoped Product Metadata observation.</td></tr>)}
    </tbody></table>
  </section>;
}
