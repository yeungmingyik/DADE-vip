import { redirect } from "next/navigation";
import { cookies } from "next/headers";

export default async function Home() { redirect((await cookies()).get("SSPC_LOCALE")?.value === "zh-CN" ? "/zh-CN" : "/en"); }
