import type { Metadata } from "next";
import { OurdreamClone } from "@/components/ourdream/OurdreamClone";

// 首页的 canonical 过去靠根布局的全站默认值兜着；那个默认值已经撤掉，这里显式声明。
export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default function Home() {
  return <OurdreamClone />;
}
