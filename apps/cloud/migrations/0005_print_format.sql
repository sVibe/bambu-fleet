-- How labels are sent to a printer: 'pdf' through its driver, or 'zpl' straight to a Zebra printer
-- (the label size travels with the job, so no paper needs setting up). NULL picks by the driver name.
ALTER TABLE print_printers ADD COLUMN format TEXT CHECK (format IN ('pdf', 'zpl'));

-- Nudge labels on a printer whose sensor or driver places them off: millimetres down and to the right.
ALTER TABLE print_printers ADD COLUMN offset_x_mm REAL NOT NULL DEFAULT 0;
ALTER TABLE print_printers ADD COLUMN offset_y_mm REAL NOT NULL DEFAULT 0;
