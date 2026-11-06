import { createFileRoute } from "@tanstack/react-router";
import Approvals from "../pages/Approvals";

export const Route = createFileRoute("/approvals")({ component: Approvals });
