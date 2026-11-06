import { createFileRoute } from "@tanstack/react-router";
import Webhooks from "../../pages/Webhooks";

export const Route = createFileRoute("/settings/webhooks")({ component: Webhooks });
