/** Figma page 03 exports, 16px with 1.4px currentColor strokes. */
import type { ReactNode } from 'react';
const ICONS = {
  "icon/ad-groups": <>
<path d="M8 2.2L13.8 5L8 7.8L2.2 5L8 2.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M2.2 8L8 10.8L13.8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M2.2 11L8 13.8L13.8 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
  "icon/brand-lens": <>
<path d="M8.4 2.4H13C13.1591 2.4 13.3117 2.46321 13.4243 2.57574C13.5368 2.68826 13.6 2.84087 13.6 3V7.6L7.6 13.6C7.41307 13.7832 7.16175 13.8859 6.9 13.8859C6.63825 13.8859 6.38693 13.7832 6.2 13.6L2.6 10C2.41677 9.81307 2.31414 9.56175 2.31414 9.3C2.31414 9.03825 2.41677 8.78693 2.6 8.6L8.4 2.4Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M11 5.7C11.3866 5.7 11.7 5.3866 11.7 5C11.7 4.6134 11.3866 4.3 11 4.3C10.6134 4.3 10.3 4.6134 10.3 5C10.3 5.3866 10.6134 5.7 11 5.7Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
  "icon/campaigns": <>
<path d="M3 6.5V9.5C3 9.76522 3.10536 10.0196 3.29289 10.2071C3.48043 10.3946 3.73478 10.5 4 10.5H5.5L9.5 13.3V2.7L5.5 5.5H4C3.73478 5.5 3.48043 5.60536 3.29289 5.79289C3.10536 5.98043 3 6.23478 3 6.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M12 5.6C12.6351 6.23728 12.9917 7.1003 12.9917 8C12.9917 8.8997 12.6351 9.76272 12 10.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
  "icon/change-queue": <>
<path d="M6.4 4.4H13.6M6.4 8H13.6M6.4 11.6H13.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M2.4 4.2L3.4 5.2L5 3.2M2.4 7.8L3.4 8.8L5 6.8M2.4 11.4L3.4 12.4L5 10.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
  "icon/create-campaigns": <>
<path d="M8 13.8C11.2033 13.8 13.8 11.2033 13.8 8C13.8 4.79675 11.2033 2.2 8 2.2C4.79675 2.2 2.2 4.79675 2.2 8C2.2 11.2033 4.79675 13.8 8 13.8Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M8 5.4V10.6M5.4 8H10.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
  "icon/creatives": <>
<path d="M12.6 4.2H3.4C2.84772 4.2 2.4 4.64772 2.4 5.2V10.8C2.4 11.3523 2.84772 11.8 3.4 11.8H12.6C13.1523 11.8 13.6 11.3523 13.6 10.8V5.2C13.6 4.64772 13.1523 4.2 12.6 4.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M6.9 6.4L9.9 8L6.9 9.6V6.4Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
  "icon/dayparting": <>
<path d="M8 13.8C11.2033 13.8 13.8 11.2033 13.8 8C13.8 4.79675 11.2033 2.2 8 2.2C4.79675 2.2 2.2 4.79675 2.2 8C2.2 11.2033 4.79675 13.8 8 13.8Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M8 4.8V8L10.3 9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
  "icon/home": <>
<path d="M2.5 6.8L8 2.5L13.5 6.8V13C13.5 13.1326 13.4473 13.2598 13.3536 13.3536C13.2598 13.4473 13.1326 13.5 13 13.5H9.5V9.5H6.5V13.5H3C2.86739 13.5 2.74021 13.4473 2.64645 13.3536C2.55268 13.2598 2.5 13.1326 2.5 13V6.8Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
  "icon/inbox": <>
<path d="M3.6 2.6H12.4L13.8 7.5V11.9C13.8 12.3 13.5 12.6 13.1 12.6H2.9C2.5 12.6 2.2 12.3 2.2 11.9V7.5L3.6 2.6Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M2.2 7.5H5.5L6.6 9.5H9.4L10.5 7.5H13.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
  "icon/market-position": <>
<path d="M2.2 11.2L6 7.4L8.6 10L13.8 4.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M10.4 4.8H14V8.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M2.2 13.8H13.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
  "icon/n-grams": <>
<path d="M5.6 2.4L4.2 13.6M11.2 2.4L9.8 13.6M2.4 5.6H13.6M2.4 10.4H13.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
  "icon/optimize-now": <>
<path d="M9.6 2.4L10.6 5L13.2 6L10.6 7L9.6 9.6L8.6 7L6 6L8.6 5L9.6 2.4Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M4 9.6L4.8 11.4L6.6 12.2L4.8 13L4 14.8L3.2 13L1.4 12.2L3.2 11.4L4 9.6Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
  "icon/placements": <>
<path d="M12.6 3.2H3.4C2.84772 3.2 2.4 3.64772 2.4 4.2V11.8C2.4 12.3523 2.84772 12.8 3.4 12.8H12.6C13.1523 12.8 13.6 12.3523 13.6 11.8V4.2C13.6 3.64772 13.1523 3.2 12.6 3.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M2.4 6.8H13.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M7 6.8V12.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
  "icon/products": <>
<path d="M8 2.2L13.5 5V11L8 13.8L2.5 11V5L8 2.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M2.5 5L8 7.8L13.5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M8 7.8V13.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
  "icon/queries": <>
<path d="M13.6 9.4C13.6 9.66522 13.4946 9.91957 13.3071 10.1071C13.1196 10.2946 12.8652 10.4 12.6 10.4H6L3 12.8V10.4C2.73478 10.4 2.48043 10.2946 2.29289 10.1071C2.10536 9.91957 2 9.66522 2 9.4V3.4C2 3.13478 2.10536 2.88043 2.29289 2.69289C2.48043 2.50536 2.73478 2.4 3 2.4H12.6C12.8652 2.4 13.1196 2.50536 13.3071 2.69289C13.4946 2.88043 13.6 3.13478 13.6 3.4V9.4Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M5.4 6.2H10.6M5.4 8.4H8.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
  "icon/search-terms": <>
<path d="M7.2 12.2C9.96142 12.2 12.2 9.96142 12.2 7.2C12.2 4.43858 9.96142 2.2 7.2 2.2C4.43858 2.2 2.2 4.43858 2.2 7.2C2.2 9.96142 4.43858 12.2 7.2 12.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M10.9 10.9L13.8 13.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
  "icon/settings": <>
<path d="M2.6 4.6H13.4M2.6 8H13.4M2.6 11.4H13.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M6 3.1V6.1M10.6 6.5V9.5M5 9.9V12.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
  "icon/sponsored-prompts": <>
<path d="M13.4 9.2C13.4 9.46522 13.2946 9.71957 13.1071 9.90711C12.9196 10.0946 12.6652 10.2 12.4 10.2H6.2L3.2 12.6V10.2H2.8C2.53478 10.2 2.28043 10.0946 2.09289 9.90711C1.90536 9.71957 1.8 9.46522 1.8 9.2V3.6C1.8 3.33478 1.90536 3.08043 2.09289 2.89289C2.28043 2.70536 2.53478 2.6 2.8 2.6H12.4C12.6652 2.6 12.9196 2.70536 13.1071 2.89289C13.2946 3.08043 13.4 3.33478 13.4 3.6V9.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M8 4.6L8.62 6.18L10.2 6.8L8.62 7.42L8 9L7.38 7.42L5.8 6.8L7.38 6.18L8 4.6Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
  "icon/targets": <>
<path d="M8 13.8C11.2033 13.8 13.8 11.2033 13.8 8C13.8 4.79675 11.2033 2.2 8 2.2C4.79675 2.2 2.2 4.79675 2.2 8C2.2 11.2033 4.79675 13.8 8 13.8Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M8 10.3C9.27026 10.3 10.3 9.27026 10.3 8C10.3 6.72975 9.27026 5.7 8 5.7C6.72975 5.7 5.7 6.72975 5.7 8C5.7 9.27026 6.72975 10.3 8 10.3Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
<path d="M8 2.2V3.8M8 12.2V13.8M2.2 8H3.8M12.2 8H13.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
  "icon/timeline": <>
<path d="M2.2 8H4.8L6.8 3.2L9.4 12.8L11.4 8H13.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
</>,
} as const;
export const FIGMA_ICON_IDS = Object.keys(ICONS);
export function NavIcon({ icon }: { icon: string }): ReactNode {
  if (!Object.prototype.hasOwnProperty.call(ICONS, icon)) throw new Error(`Unknown navigation icon: ${icon}`);
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" data-icon={icon}>
    {ICONS[icon as keyof typeof ICONS]}
  </svg>;
}
