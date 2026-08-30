import { createPrismaClient } from "../src/server/db/create-prisma-client";
import { seedDemo } from "./demo-data";
const database = createPrismaClient();
try {
  await seedDemo(database);
  console.log(
    "Демокаталог готов: 3 вымышленные услуги, 2 мастера, недельные часы и перерывы. Существующие данные не изменены; записи и контакты не создавались.",
  );
} finally {
  await database.$disconnect();
}
