import { createFileRoute } from "@tanstack/react-router";
import Appearance from "../../pages/Appearance";

export const Route = createFileRoute("/settings/appearance")({ component: Appearance });
