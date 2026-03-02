import { z } from "zod";
import { stopListener as stopListenerImpl } from "./start_listener.js";

export const stopListenerSchema = z.object({});

export async function stopListener(_args: z.infer<typeof stopListenerSchema>): Promise<string> {
  return stopListenerImpl();
}
