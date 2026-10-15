import { z } from "zod";
import { isIsoDate } from "@schoolpulse/domain";

export const uuid = z.string().uuid();
export const isoDate = z.string().refine(isIsoDate, "Expected a real calendar date as YYYY-MM-DD");
