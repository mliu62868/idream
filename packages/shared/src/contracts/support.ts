import { z } from "zod";

export const supportMessageBodySchema = z.string().trim().min(1).max(2_000);
export const supportMessageSchema = z.object({
  id: z.string().min(1),
  author: z.enum(["customer", "support"]),
  body: supportMessageBodySchema,
  createdAt: z.iso.datetime(),
}).strict();

export const supportConversationSchema = z.object({
  ticketId: z.string().min(1),
  subject: z.string(),
  description: z.string(),
  status: z.enum(["received", "open", "waiting_on_user", "resolved", "closed"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  canReply: z.boolean(),
  messages: z.array(supportMessageSchema),
}).strict();

export const supportConversationResponseSchema = z.object({ request: supportConversationSchema }).strict();
export const supportReplyRequestSchema = z.object({
  messageId: z.uuid(),
  body: supportMessageBodySchema,
}).strict();
export const supportReplyResponseSchema = supportConversationResponseSchema.extend({ replayed: z.boolean() });
export type SupportConversation = z.infer<typeof supportConversationSchema>;
