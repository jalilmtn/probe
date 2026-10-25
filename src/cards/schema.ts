import { z } from "zod";

/**
 * What an agent may submit as a card. Probe fills in feature, status, author and time,
 * so an agent can never approve its own card.
 */
export const CardInput = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "kebab-case, e.g. send-image-message")
    .describe("Stable kebab-case id, unique within the feature."),
  level: z
    .enum(["feature", "capability", "regression"])
    .describe("feature = one overview card; capability = a user-visible flow; regression = guards a past bug."),
  title: z.string().min(3),
  summary: z.string().describe("One or two sentences: what the user can do and why it matters."),
  reach: z.array(z.string()).describe("Navigation path from app start, one hop per item, e.g. ['Home', 'Chats tab', 'Open any chat']."),
  preconditions: z.array(z.string()).default([]).describe("State needed before the steps, e.g. 'logged in', 'has at least one post'."),
  steps: z.array(z.string()).min(1).describe("What a tester does, in order."),
  expect: z
    .array(
      z.object({
        text: z.string().describe("Something observable that must be true."),
        check: z
          .enum(["ui", "log", "network", "state", "manual"])
          .default("ui")
          .describe("How it can be verified: on screen, in logcat, as a request, from app state, or only by a person."),
      }),
    )
    .min(1),
  accounts: z.number().int().min(0).max(4).default(1).describe("Test accounts needed (2 for chat/calls between users)."),
  modules: z.array(z.string()).default([]).describe("Build modules this behaviour lives in."),
  tickets: z.array(z.string()).default([]).describe("Ticket ids, e.g. PROJ-123."),
  sources: z
    .array(
      z.object({
        type: z.enum(["code", "doc", "commit", "test", "device"]),
        ref: z.string().describe("File path, doc path#heading, commit hash, or test class."),
        note: z.string().optional(),
      }),
    )
    .min(1)
    .describe("Where this knowledge came from. Every card cites at least one."),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe("high = seen on a device; medium = clear in code/docs; low = inferred."),
});

export type CardInput = z.infer<typeof CardInput>;
