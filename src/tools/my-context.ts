import { vaultRead } from "@/lib/github";

const CONTEXT_PATH = "System/context.md";

export async function handleMyContext() {
  try {
    const file = await vaultRead(CONTEXT_PATH);

    return {
      content: [
        {
          type: "text" as const,
          text: file.content,
        },
      ],
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";

    // If the context note doesn't exist yet, return a helpful message
    if (message.includes("not found")) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Context note not found at "${CONTEXT_PATH}". Create it in your Obsidian vault with your personal context (role, projects, priorities, stack, etc.).`,
          },
        ],
      };
    }

    throw error;
  }
}
