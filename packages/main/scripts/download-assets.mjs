import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const assets = [
  {
    url: "https://ourdream.ai/logos/OurDreamLogo.svg",
    output: "public/images/ourdream/ourdream-logo.svg",
  },
  {
    url: "https://media.ourdream.ai/cdn-cgi/image/format=auto,q=90/ourdream_hero_logo_final.png",
    output: "public/images/ourdream/age-gate-logo.png",
  },
  {
    url: "https://static.ourdream.ai/PromoCardFemale.webp",
    output: "public/images/ourdream/promo-card-female.webp",
  },
  {
    url: "https://static.ourdream.ai/PrideCardFemale.webp",
    output: "public/images/ourdream/pride-card-female.webp",
  },
  {
    url: "https://static.ourdream.ai/pridebanner_female.webp",
    output: "public/images/ourdream/pride-banner-female.webp",
  },
  {
    url: "https://ourdream.ai/favicon.ico",
    output: "public/seo/favicon.ico",
  },
  {
    url: "https://img.ourdream.ai/thumb/20805cce-4a7b-44a0-8d59-af59843cf4a2?sig=f_z3dN3MUvE5iGFg&exp=83941500",
    output: "public/images/ourdream/card-melissa-burke.webp",
  },
  {
    url: "https://img.ourdream.ai/thumb/843a6635-e96d-4e0a-8ccd-d7955aa6ab59?sig=vfE0Tsl3_Z3Wwz50&exp=83941500",
    output: "public/images/ourdream/card-summoned-world.webp",
  },
  {
    url: "https://img.ourdream.ai/thumb/6e72b160-ea0b-4f72-a366-99fe50038d07?sig=efVrU2z5YIEM4ETW&exp=83941500",
    output: "public/images/ourdream/card-sarah-mercer.webp",
  },
  {
    url: "https://img.ourdream.ai/thumb/9e8f9e53-ba50-4a19-946b-b77061190947?sig=MVxmgZLu7Trl5W9L&exp=83941500",
    output: "public/images/ourdream/card-alexa-reeves.webp",
  },
  {
    url: "https://img.ourdream.ai/thumb/2d4ecca4-9a9b-4ef6-8d19-0342db4d8fee?sig=N17t1rbZkEaOipVC&exp=83941500",
    output: "public/images/ourdream/card-tamsin-jacobs.webp",
  },
  {
    url: "https://img.ourdream.ai/thumb/9a8a3353-9923-45ae-aacd-2fca18365d2b?sig=vN6QYwpozEszv08P&exp=83941500",
    output: "public/images/ourdream/card-truth-confessional.webp",
  },
  {
    url: "https://img.ourdream.ai/thumb/aa5dbe17-e080-4aa0-9c96-ae52ca3145ba?sig=Jj6S86mMBBMfKdf-&exp=83941500",
    output: "public/images/ourdream/card-truth-stepmother.webp",
  },
  {
    url: "https://img.ourdream.ai/thumb/bf1dd025-8814-4bce-8cdf-7f0220f48eba?sig=bcMheM9Vcr52xI9_&exp=83941500",
    output: "public/images/ourdream/card-stephanie.webp",
  },
  {
    url: "https://img.ourdream.ai/thumb/b6d4189d-5bea-4fd9-b651-6662a8792bd9?sig=ZwCbErn7MI4J9OBu&exp=83941500",
    output: "public/images/ourdream/card-kennedy-graham.webp",
  },
  {
    url: "https://img.ourdream.ai/thumb/4fa91e27-21b9-4745-b42a-bac4b608443a?sig=g9ToNA6Phc6UridE&exp=83941500",
    output: "public/images/ourdream/card-eleanor-dawn.webp",
  },
  {
    url: "https://img.ourdream.ai/thumb/c401e2de-de74-495e-9ee7-b82fb417bcaf?sig=SWCrnNDHDiIArO4M&exp=83941500",
    output: "public/images/ourdream/card-bailey-price.webp",
  },
  {
    url: "https://img.ourdream.ai/thumb/0eda1717-4dc9-4b6a-8a27-17eda0612387?sig=rzSpx9w02opqXuME&exp=83941500",
    output: "public/images/ourdream/card-sophie.webp",
  },
  {
    url: "https://img.ourdream.ai/thumb/96fcf975-1149-4e7b-a170-c68f2e38774f?sig=nblAaQYxYD0ms3qr&exp=83941500",
    output: "public/images/ourdream/card-raya-reyes.webp",
  },
  {
    url: "https://img.ourdream.ai/thumb/0ea2d3f1-75a9-45e8-9057-728065f94562?sig=JEszgdbup8IX_dpL&exp=83941500",
    output: "public/images/ourdream/card-emily-coming-home.webp",
  },
  {
    url: "https://img.ourdream.ai/thumb/61881f02-695f-414a-b6b2-c338eb08f977?sig=sze2dngK4XQ5M9oh&exp=83941500",
    output: "public/images/ourdream/card-diana-weird-girl.webp",
  },
  {
    url: "https://img.ourdream.ai/thumb/cbc87da6-0589-4841-bc69-95edfbc938d6?sig=wLOHdnMDqCtp5qbc&exp=83941500",
    output: "public/images/ourdream/card-lola-moonstruck.webp",
  },
];

const concurrency = 4;

async function downloadAsset(asset) {
  const response = await fetch(asset.url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} ${asset.url}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(path.dirname(asset.output), { recursive: true });
  await writeFile(asset.output, bytes);
  return { output: asset.output, bytes: bytes.length };
}

const results = [];

for (let index = 0; index < assets.length; index += concurrency) {
  const batch = assets.slice(index, index + concurrency);
  results.push(...(await Promise.all(batch.map(downloadAsset))));
}

console.log(JSON.stringify({ downloaded: results.length, results }, null, 2));
