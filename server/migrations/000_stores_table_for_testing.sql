-- NOT part of the delivery. This is a stand-in for the `stores` table that already
-- exists in the client's CRM, so the real migration (001) can be tested against a
-- real MySQL server before it is ever run on their VPS.
CREATE TABLE stores (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(191) NOT NULL,
  category   VARCHAR(64)  NOT NULL,
  address    VARCHAR(255) NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
