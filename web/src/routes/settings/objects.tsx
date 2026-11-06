import { createFileRoute } from "@tanstack/react-router";
import ObjectsSettings from "../../pages/ObjectsSettings";

export const Route = createFileRoute("/settings/objects")({ component: ObjectsSettings });
