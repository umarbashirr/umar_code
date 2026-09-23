/* A server's logo on a rounded tile in its brand color, from simple-icons
   (CC0). Only the icons named here are imported, so the bundle carries these
   and not the whole set. A brand simple-icons lacks gets its first letter. */
import {
  siAirtable, siAtlassian, siClickup, siCloudflare, siDropbox, siGitlab, siHuggingface, siIntercom, siLinear,
  siMiro, siNeon, siNetlify, siNotion, siPaypal, siPosthog, siPrisma, siSentry, siSquare, siStripe, siSupabase,
  siTodoist, siWebflow, siWix, siZapier,
} from 'simple-icons';

const ICONS = {
  siAirtable, siAtlassian, siClickup, siCloudflare, siDropbox, siGitlab, siHuggingface, siIntercom, siLinear,
  siMiro, siNeon, siNetlify, siNotion, siPaypal, siPosthog, siPrisma, siSentry, siSquare, siStripe, siSupabase,
  siTodoist, siWebflow, siWix, siZapier,
};

function luminance(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const TILE = 'flex size-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ring-black/10 dark:ring-white/10';

export function BrandTile({ icon, name }) {
  const mark = ICONS[icon];
  if (!mark) {
    return <div className={`${TILE} bg-muted font-medium text-muted-foreground text-sm`}>{name.charAt(0).toUpperCase()}</div>;
  }
  const light = luminance(mark.hex);
  // A near-black brand would be a black hole on a dark theme, so it sits on
  // white in its own color. A light brand takes a black mark rather than white.
  const onWhite = light < 0.02;
  const background = onWhite ? '#fff' : `#${mark.hex}`;
  const fill = onWhite ? `#${mark.hex}` : light > 0.4 ? '#000' : '#fff';
  return (
    <div className={TILE} style={{ background }}>
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-[18px]" fill={fill}><path d={mark.path} /></svg>
    </div>
  );
}
