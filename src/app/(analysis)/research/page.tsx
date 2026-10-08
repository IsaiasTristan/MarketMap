import { redirect } from "next/navigation";

/** The module tab and any old bookmark land on the universe screen. */
export default function ResearchPage() {
  redirect("/research/revision");
}
