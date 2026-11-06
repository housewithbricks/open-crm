import { createFileRoute } from "@tanstack/react-router";
import Tasks from "../pages/Tasks";

export const Route = createFileRoute("/tasks")({ component: Tasks });
