import { CreatorProfileClient } from "@/components/ourdream/CreatorProfileClient";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function CreatorPage({ params }: PageProps) {
  const { id } = await params;
  return <CreatorProfileClient id={id} />;
}
