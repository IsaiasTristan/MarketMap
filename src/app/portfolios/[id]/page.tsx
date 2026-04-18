import { notFound } from "next/navigation";
import { prisma } from "@/infrastructure/db/client";
import { PortfolioDetailClient } from "./PortfolioDetailClient";

type Props = { params: Promise<{ id: string }> };

export default async function PortfolioDetailPage({ params }: Props) {
  const { id } = await params;
  const p = await prisma.portfolio.findUnique({ where: { id } });
  if (!p) notFound();
  return <PortfolioDetailClient id={id} />;
}
