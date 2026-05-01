import type { Router } from "express";
import { z } from "zod";

const CustomerSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email()
});
type Customer = z.infer<typeof CustomerSchema>;

const CreateCustomerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email()
});

const customers: Customer[] = [
  { id: "cust_1", name: "Acme Corp", email: "billing@acme.example" },
  { id: "cust_2", name: "Globex", email: "ap@globex.example" }
];

export function registerCustomerRoutes(router: Router) {
  router.get("/customers", (_req, res) => {
    res.json({ data: customers });
  });

  router.post("/customers", (req, res) => {
    const parsed = CreateCustomerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    }

    const newCustomer: Customer = {
      id: `cust_${Date.now()}`,
      name: parsed.data.name,
      email: parsed.data.email
    };
    customers.push(newCustomer);
    res.status(201).json({ data: newCustomer });
  });
}

