# How-to: Fluxo de API para Eventos e Inscrições

Este guia descreve os passos necessários para configurar um evento com produtos e lotes (batches) e realizar uma inscrição.

## 1. Criar um Evento

**Endpoint:** `POST /api/events`

Crie o evento base que conterá os produtos.

**Payload:**

```json
{
  "data": {
    "name": "Meu Evento Incrível",
    "pixai_token_integration": "seu_token_aqui",
    "pixai_token_integration_id": "seu_id_aqui"
  }
}
```

---

## 2. Criar Produtos do Evento

**Endpoint:** `POST /api/products`

Produtos representam as categorias de ingressos (ex: "Profissional", "Estudante"). Eles devem estar vinculados ao ID do Evento criado no passo anterior.

**Payload:**

```json
{
  "data": {
    "name": "Ingresso VIP",
    "event": 1,
    "enabled": true,
    "can_be_listed": true
  }
}
```

---

## 3. Criar Lotes (Batches) do Evento

**Endpoint:** `POST /api/batches`

Lotes representam os preços e quantidades específicos para um produto em um determinado momento (ex: "Lote 1", "Lote 2"). Eles devem estar vinculados ao ID do Produto.

**Payload:**

```json
{
  "data": {
    "batch_number": 1,
    "value": 15000,
    "max_quantity": 100,
    "product": 1,
    "valid_from": "2024-02-15T00:00:00.000Z",
    "valid_until": "2024-03-15T23:59:59.000Z",
    "enabled": true
  }
}
```

---

## 4. Fazer a Inscrição (Signup)

**Endpoint:** `POST /api/signup/:id`
_(Onde `:id` é o ID do Evento)_

Para realizar a inscrição, você deve enviar o `batch_id` escolhido. O sistema validará se o lote está ativo, dentro do prazo e se há estoque.

**Payload:**

```json
{
  "name": "João Silva",
  "email": "joao@email.com",
  "phone_number": "11999999999",
  "batch_id": 1,
  "t_shirt_size": "G"
}
```

---

## Dica: Consultar Eventos com Produtos e Lotes

Para listar os eventos e já trazer os produtos e lotes disponíveis, utilize o parâmetro `populate`:

`GET /api/events?populate[products][populate][batches]=*`

---

## 5. Regras Avançadas

### 5.1 Capacidade Total do Evento

Você pode definir um limite global de vagas no evento através do campo `max_slots` no modelo `Event`. O sistema negará novas inscrições assim que a soma de pagamentos confirmados e pendentes atingir esse valor.

### 5.2 Cupons de Desconto

Os cupons são vinculados a um evento e aplicam um desconto percentual.

- **Payload de Criação (`POST /api/coupons`):**

```json
{
  "data": {
    "code": "COMMUNITY50",
    "discount_percentage": 50,
    "max_uses": 20,
    "event": 1,
    "enabled": true
  }
}
```

- **Uso no Signup:** Envie o campo `coupon_code` no corpo da requisição de inscrição.

### 5.3 Meia-Entrada (Estudantes)

1. No modelo `Batch`, marque o campo `half_price_eligible` como `true`.
2. No momento da inscrição (`POST /api/signup/:id`), envie o campo `"is_student": true`.
3. O sistema aplicará automaticamente 50% de desconto sobre o valor do lote (ou sobre o valor já com desconto de cupom, se houver).

**Payload de Signup com Descontos:**

```json
{
  "name": "Maria Souza",
  "email": "maria@email.com",
  "batch_id": 1,
  "coupon_code": "WELCOMEOFF",
  "is_student": true
}
```

---

## 6. Validações e Erros

Ao realizar uma inscrição (`POST /api/signup/:id`), o sistema executa uma série de validações. Em caso de falha, retornará HTTP 400 com um JSON no formato: `{ "status": "error", "message": "..." }`.

### Tabela de Erros Comuns

| Cenário                 | Mensagem de Erro                               | Causa                                                     |
| :---------------------- | :--------------------------------------------- | :-------------------------------------------------------- |
| **Inscrição Duplicada** | "Você já está inscrito neste evento!"          | Já existe um cadastro com este e-mail para este evento.   |
| **Lote Vencido**        | "Este lote já encerrou as vendas."             | A data atual é posterior a `valid_until` do lote.         |
| **Lote Não Aberto**     | "Este lote ainda não abriu."                   | A data atual é anterior a `valid_from` do lote.           |
| **Lote Esgotado**       | "As vagas para este lote esgotaram."           | O limite `max_quantity` do lote foi atingido.             |
| **Evento Lotado**       | "Este evento já atingiu a lotação máxima."     | O limite `max_slots` do evento foi atingido.              |
| **Cupom Inválido**      | "Cupom inválido ou desativado."                | O código enviado não existe ou o campo `enabled` é falso. |
| **Cupom Expirado**      | "Este cupom já expirou."                       | A data de validade do cupom passou.                       |
| **Cupom esgotado**      | "Este cupom atingiu o limite de usos."         | O cupom atingiu seu `max_uses`.                           |
| **Produto Desativado**  | "Este produto não está disponível no momento." | O Produto ou Lote está com `enabled: false`.              |

---

### Declaração de maioridade (REA-36)

O Hub só aceita inscrições de quem tem 18 anos ou mais. O BFF exige o checkbox "Declaro que tenho 18 anos ou mais" e envia `adult_declaration: true` no corpo do `POST /api/signup/:id`; a inscrição grava o momento em `adult_declaration_at` (também numa nova tentativa de pagamento da mesma inscrição). Sem o campo, a inscrição é salva como antes e `adult_declaration_at` fica nulo. O credenciamento manual do BFF grava `adult_declaration_at` direto na inscrição.

---

## 7. Aprovação Manual de Inscrição (REA-34)

Rotas usadas pelo BFF, com o token de API de acesso total (sem `auth: false`). O BFF só chama para quem é admin. Não gera cobrança nem mexe no Opa Pingou: o Payment vira `CONFIRMED` e guarda `manual_approved_at` e `manual_approved_by` (`{ id, email, name }`); `value`, `original_value`, `coupon` e `batch` ficam como estavam e quem lê trata a inscrição como R$ 0, fora da receita.

Aprováveis: Payment `PEDING_PAYMENT` (mesmo com o Pix ainda válido), `EXPIRED` ou `CANCELED`. Não aprováveis: `REFUND`, `CONFIRMED` e inscrição sem Payment (importada/manual). Lote lotado, evento lotado ou cupom esgotado não impedem: viram `warnings` (contagens de `ACTIVE_WHERE` sem o próprio pagamento).

**Pré-visualização:** `GET /api/payment/manual-approval/preview?event_id=<id do evento>&signup_id=<id da inscrição>`

```json
{ "approvable": true, "reason": null, "status": "EXPIRED", "warnings": ["BATCH_FULL"] }
```

`reason`: `null` | `NOT_FOUND` | `NO_PAYMENT` | `ALREADY_CONFIRMED` | `REFUNDED` | `ALREADY_APPROVED`. `warnings`: `BATCH_FULL`, `EVENT_FULL`, `COUPON_EXHAUSTED`.

**Aprovação:** `POST /api/payment/manual-approval`

```json
{ "event_id": 2, "signup_id": 3, "approved_by": { "id": "42", "email": "admin@x.com", "name": "Admin" } }
```

- `200` `{ approved: true, already_approved, warnings, payment: { id, status, value, manual_approved_at, manual_approved_by }, signup: { id, documentId, name, email, phone_number, cpf }, event: { id, uuid, slug } }`. Aprovar uma já aprovada manualmente devolve `already_approved: true` sem alterar nada.
- `404` `{ error: { code: "NOT_FOUND" } }`: inscrição inexistente ou de outro evento.
- `409` `{ error: { code: "NO_PAYMENT" | "ALREADY_CONFIRMED" | "REFUNDED" } }`.
- `400` `{ error: { code: "INVALID_APPROVER" } }`: `approved_by` sem `id` nem `email`.

A transição é condicional ao status de origem, então não corre com um webhook. Webhook posterior (`charge.expired`, `charge.canceled` ou `charge.paid`) nunca desfaz a aprovação nem manda segundo e-mail; o caso fica no log (`[opapingou] pagamento <id> aprovado manualmente; <tipo>/<status> ignorado`).
