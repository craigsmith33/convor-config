"""Generates the Tallmark Industrial Supply sample books for the QuickBooks sandbox.

Tallmark is the fictional distributor used by the Sales Assistant demo (see the
Tallmark PDFs). This script turns that company into about 21 months of books:
January 2025 to the as-of date, roughly $60M a year in sales, priced from the
Tallmark price guide with the guide's tier and volume discounts.

Output: tallmark-books.json (read by tallmark-loader.mjs) and a printed summary
of the expected statements, used to check the load.
Deterministic: the same seed always produces the same books.
"""
import json, random, calendar, hashlib, sys
from datetime import date, timedelta
from decimal import Decimal as D, ROUND_HALF_UP
from collections import defaultdict

VERSION = "tallmark-books-2026-10-12-v1"
AS_OF = date(2026, 10, 12)
START = date(2025, 1, 1)
R = random.Random(19940101)
C = D("0.01")

def q(x):
    return D(x).quantize(C, rounding=ROUND_HALF_UP)

def bday(d):
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d

def bday_back(d):
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d

def months():
    y, m = START.year, START.month
    while date(y, m, 1) <= AS_OF:
        yield y, m
        m += 1
        if m == 13:
            y, m = y + 1, 1

def month_days(y, m):
    last = calendar.monthrange(y, m)[1]
    end = date(y, m, last)
    if end > AS_OF:
        end = AS_OF
    return [date(y, m, d) for d in range(1, end.day + 1) if date(y, m, d).weekday() < 5]

def last_bday(y, m):
    return bday_back(date(y, m, calendar.monthrange(y, m)[1]))

# ---------------------------------------------------------------- company
COMPANY = {
    "name": "Tallmark Industrial Supply",
    "legalName": "Tallmark Industrial Supply, Inc.",
    "address": {"Line1": "4800 Commerce Park Drive", "City": "Indianapolis", "CountrySubDivisionCode": "IN", "PostalCode": "46268", "Country": "USA"},
    "phone": "(317) 555-0142",
    "email": "accounting@tallmark.example",
    "web": "https://www.tallmark.example",
}

# ---------------------------------------------------------------- chart of accounts
INC = {
    "motion": "Product Sales:Motion Control",
    "controls": "Product Sales:Automation & Controls",
    "sensing": "Product Sales:Sensing",
    "material": "Product Sales:Material Handling",
    "cobot": "Product Sales:Collaborative Robots",
    "fluid": "Product Sales:Fluid Power",
    "third": "Product Sales:Third-Party Products",
    "panel": "Service Revenue:Panel Building & Integration",
    "repair": "Service Revenue:Repair & Exchange",
    "field": "Service Revenue:Field Service & Maintenance",
    "training": "Service Revenue:Training",
}
ACCOUNTS = {
    "rename": [
        {"from": "Checking", "to": "Operating Checking"},
        {"from": "Savings", "to": "Money Market Reserve", "subType": "MoneyMarket"},
        {"from": "Mastercard", "to": "Company Card"},
        {"from": "Loan Payable", "to": "Line of Credit", "subType": "LineOfCredit"},
        {"from": "Notes Payable", "to": "Term Loan - Equipment", "subType": "NotesPayable"},
        {"from": "Sales of Product Income", "to": "Product Sales"},
        {"from": "Services", "to": "Service Revenue"},
        {"from": "Advertising", "to": "Marketing & Advertising"},
        {"from": "Interest Earned", "to": "Interest Income"},
    ],
    "create": [
        {"name": "Warehouse Equipment & Racking", "type": "Fixed Asset", "subType": "MachineryAndEquipment"},
        {"name": "Vehicles", "type": "Fixed Asset", "subType": "Vehicles"},
        {"name": "Computer Equipment", "type": "Fixed Asset", "subType": "FurnitureAndFixtures"},
        {"name": "Accumulated Depreciation", "type": "Fixed Asset", "subType": "AccumulatedDepreciation"},
        {"name": "Common Stock", "type": "Equity", "subType": "CommonStock"},
        {"name": "Shareholder Distributions", "type": "Equity", "subType": "PartnerDistributions"},
    ]
    + [{"name": n, "type": "Income", "subType": "SalesOfProductIncome"} for k, n in INC.items() if n.startswith("Product Sales:")]
    + [{"name": n, "type": "Income", "subType": "ServiceFeeIncome"} for k, n in INC.items() if n.startswith("Service Revenue:")]
    + [
        {"name": "Cost of Goods Sold:Product Cost", "type": "Cost of Goods Sold", "subType": "SuppliesMaterialsCogs"},
        {"name": "Cost of Goods Sold:Inbound Freight", "type": "Cost of Goods Sold", "subType": "ShippingFreightDeliveryCos"},
        {"name": "Cost of Goods Sold:Service Parts & Subcontract", "type": "Cost of Goods Sold", "subType": "OtherCostsOfServiceCos"},
        {"name": "Payroll Expenses", "type": "Expense", "subType": "PayrollExpenses"},
        {"name": "Payroll Expenses:Salaries & Wages", "type": "Expense", "subType": "PayrollExpenses"},
        {"name": "Payroll Expenses:Payroll Taxes", "type": "Expense", "subType": "PayrollExpenses"},
        {"name": "Payroll Expenses:Employee Benefits", "type": "Expense", "subType": "PayrollExpenses"},
        {"name": "Payroll Expenses:Sales Commissions", "type": "Expense", "subType": "PayrollExpenses"},
        {"name": "Shipping & Delivery", "type": "Expense", "subType": "ShippingFreightDelivery"},
        {"name": "Software & IT", "type": "Expense", "subType": "OfficeGeneralAdministrativeExpenses"},
        {"name": "Interest Expense", "type": "Other Expense", "subType": "OtherMiscellaneousExpense"},
    ],
    # Intuit sample accounts that have no place in Tallmark's books. Made
    # inactive once their balance is zero.
    "deactivate": [
        "Landscaping Services:Job Materials:Decks and Patios", "Landscaping Services:Job Materials:Fountains and Garden Lighting",
        "Landscaping Services:Job Materials:Plants and Soil", "Landscaping Services:Job Materials:Sprinklers and Drip Systems",
        "Landscaping Services:Labor:Installation", "Landscaping Services:Labor:Maintenance and Repair",
        "Landscaping Services:Job Materials", "Landscaping Services:Labor", "Landscaping Services",
        "Pest Control Services", "Design income", "Fees Billed", "Other Income", "Refunds-Allowances",
        "Job Expenses:Job Materials:Decks and Patios", "Job Expenses:Job Materials:Fountain and Garden Lighting",
        "Job Expenses:Job Materials:Plants and Soil", "Job Expenses:Job Materials:Sprinklers and Drip Systems",
        "Job Expenses:Cost of Labor:Installation", "Job Expenses:Cost of Labor:Maintenance and Repairs",
        "Job Expenses:Job Materials", "Job Expenses:Cost of Labor", "Job Expenses:Equipment Rental", "Job Expenses:Permits", "Job Expenses",
        "Disposal Fees", "Equipment Rental", "Promotional", "Stationery & Printing", "Commissions & fees",
        "Legal & Professional Fees:Bookkeeper", "Maintenance and Repair:Computer Repairs",
        "Truck:Original Cost", "Truck:Depreciation", "Truck", "Visa", "Purchases", "Miscellaneous",
        "Other Portfolio Income", "Travel Meals",
    ],
}
BANK = "Operating Checking"
MM = "Money Market Reserve"
CARD = "Company Card"

TERMS = [{"name": "Due on receipt", "dueDays": 0}, {"name": "Net 15", "dueDays": 15}, {"name": "Net 30", "dueDays": 30},
         {"name": "Net 45", "dueDays": 45}, {"name": "Net 60", "dueDays": 60}]
TERM_DAYS = {t["name"]: t["dueDays"] for t in TERMS}

# ---------------------------------------------------------------- catalog (Tallmark price guide, Jan 2026)
SKUS = [
    # sku, description, list, line, weight
    ("TM-SV200", "MotionPro servo motor, 200 W", 485, "motion", 5), ("TM-SV400", "MotionPro servo motor, 400 W", 560, "motion", 9),
    ("TM-SV750", "MotionPro servo motor, 750 W", 690, "motion", 8), ("TM-SV1K5", "MotionPro servo motor, 1.5 kW", 1240, "motion", 6),
    ("TM-SD400", "MotionPro servo drive, up to 400 W", 640, "motion", 9), ("TM-SD1K5", "MotionPro servo drive, up to 1.5 kW", 980, "motion", 7),
    ("TM-CBL-05", "MotionPro motor and encoder cable set, 5 m", 95, "motion", 8), ("TM-GH60-10", "MotionPro planetary gearhead, 60 mm, 10:1", 410, "motion", 4),
    ("TM-ST23", "MotionPro stepper motor, NEMA 23", 120, "motion", 4), ("TM-SDR23", "MotionPro stepper driver", 145, "motion", 4),
    ("CL-PLC-16", "ControlLine compact PLC, 16 I/O", 395, "controls", 7), ("CL-PLC-32", "ControlLine compact PLC, 32 I/O", 590, "controls", 7),
    ("CL-IO-8DI", "ControlLine I/O module, 8 digital inputs", 110, "controls", 6), ("CL-IO-8DO", "ControlLine I/O module, 8 digital outputs", 120, "controls", 6),
    ("CL-HMI-7", "ControlLine touchscreen HMI, 7 inch", 720, "controls", 6), ("CL-HMI-10", "ControlLine touchscreen HMI, 10 inch", 1050, "controls", 5),
    ("CL-SR-2", "ControlLine safety relay, 2-channel", 210, "controls", 5),
    ("SL-PE-R", "SenseLine photo-eye, retroreflective", 68, "sensing", 8), ("SL-PE-D", "SenseLine photo-eye, diffuse", 59, "sensing", 6),
    ("SL-PX-12", "SenseLine inductive proximity sensor, M12", 34, "sensing", 8), ("SL-PX-18", "SenseLine inductive proximity sensor, M18", 39, "sensing", 6),
    ("SL-VS-1", "SenseLine vision sensor", 1450, "sensing", 5), ("SL-KIT-PE", "SenseLine photo-eye kit", 95, "sensing", 5),
    ("FC-B300-1M", "FlexConvey belt conveyor section, 300 mm x 1 m", 1850, "material", 4), ("FC-B300-2M", "FlexConvey belt conveyor section, 300 mm x 2 m", 2690, "material", 6),
    ("FC-B450-2M", "FlexConvey belt conveyor section, 450 mm x 2 m", 3240, "material", 5), ("FC-CRV-90", "FlexConvey 90-degree curve, 300 mm", 2150, "material", 3),
    ("FC-DRV-90", "FlexConvey drive unit, 90 W", 1120, "material", 5), ("FC-STD", "FlexConvey support stands, pair", 260, "material", 5),
    ("CB-5", "Tallmark CoBot collaborative robot, 5 kg", 24500, "cobot", 4), ("CB-10", "Tallmark CoBot collaborative robot, 10 kg", 31800, "cobot", 5),
    ("CB-GR-E", "Tallmark CoBot electric gripper", 2900, "cobot", 4), ("CB-PAL", "Tallmark CoBot palletizing kit", 14900, "cobot", 3),
    ("FP-CYL-32-100", "Pneumatic cylinder, 32 mm bore x 100 mm", 88, "fluid", 6), ("FP-VLV-52", "Solenoid valve, 5/2, 24 VDC", 96, "fluid", 6),
    ("FP-FRL-14", "Filter-regulator-lubricator, 1/4 inch", 74, "fluid", 4),
]
SERVICES = [
    # key, name, description, line, price (None = per line)
    ("SVC-PANEL", "Panel build & integration", "UL 508A control panel build and integration (project)", "panel", None),
    ("SVC-REPAIR-MTR", "Servo motor repair", "Servo motor repair, 5-day standard turnaround", "repair", None),
    ("SVC-REPAIR-DRV", "Servo drive repair", "Servo drive repair, 5-day standard turnaround", "repair", None),
    ("SVC-REPAIR-HMI", "HMI repair", "HMI repair, 5-day standard turnaround", "repair", None),
    ("SVC-EVAL", "Repair evaluation", "Repair evaluation (servo motor, drive or HMI)", "repair", 195),
    ("SVC-FIELD", "Field service technician", "Field service technician, per hour", "field", 165),
    ("SVC-PM-ESS", "Preventive maintenance plan - Essential", "Preventive maintenance plan, Essential, 12 months (one line)", "field", 1800),
    ("SVC-PM-STD", "Preventive maintenance plan - Standard", "Preventive maintenance plan, Standard, 12 months (one line)", "field", 3600),
    ("SVC-PM-PREM", "Preventive maintenance plan - Premium", "Preventive maintenance plan, Premium, 12 months (one line)", "field", 7200),
    ("SVC-TRAIN", "On-site training", "On-site training, per day (up to 8 people)", "training", 1200),
    ("3P-SOURCED", "Third-party product (sourced)", "Third-party product sourced on request", "third", None),
]
THIRD_DESCS = ["Variable frequency drive, 10 hp (sourced on request)", "Safety light curtain pair, 900 mm (sourced on request)",
               "Barcode scanner, fixed mount (sourced on request)", "Gearmotor, right-angle, 1 hp (sourced on request)",
               "Hydraulic power unit, 5 hp (sourced on request)", "Industrial Ethernet switch, 16 port (sourced on request)",
               "Linear actuator, 600 mm stroke (sourced on request)", "Machine guarding panels and hardware (sourced on request)",
               "Air compressor service kit (sourced on request)", "Pallet wrapper replacement parts (sourced on request)"]
REPAIR_RATE = {"SVC-REPAIR-MTR": (420, 780), "SVC-REPAIR-DRV": (360, 640), "SVC-REPAIR-HMI": (290, 520)}

# Gross margin by product line (share of sales kept after product cost).
MARGIN = {"motion": .38, "controls": .40, "sensing": .44, "material": .33, "cobot": .24, "fluid": .35, "third": .19,
          "panel": .31, "repair": .55, "field": .62, "training": .72}

ITEMS = []
for sku, desc, price, line, _ in SKUS:
    ITEMS.append({"key": sku, "name": sku, "sku": sku, "desc": desc, "type": "NonInventory", "incomeAccount": INC[line],
                  "expenseAccount": "Cost of Goods Sold:Product Cost", "price": price})
for key, name, desc, line, price in SERVICES:
    ITEMS.append({"key": key, "name": name, "sku": key, "desc": desc, "type": "NonInventory" if key == "3P-SOURCED" else "Service",
                  "incomeAccount": INC[line], "price": price or 0})
LIST = {s[0]: D(s[2]) for s in SKUS}
SKU_LINE = {s[0]: s[3] for s in SKUS}
SKU_DESC = {s[0]: s[1] for s in SKUS}
BY_LINE = defaultdict(list)
for s in SKUS:
    BY_LINE[s[3]].append(s)

# ---------------------------------------------------------------- customers
FIRST = ["Megan", "Brian", "Tanya", "Luis", "Karen", "Derek", "Priya", "Scott", "Angela", "Marcus", "Holly", "Jamal", "Renee", "Travis", "Wendy",
         "Gavin", "Nicole", "Owen", "Beth", "Carlos", "Dana", "Ethan", "Faith", "Grant", "Heidi", "Isaac", "Jill", "Kyle", "Lena", "Mason",
         "Nora", "Pete", "Quinn", "Rosa", "Seth", "Tara", "Uriel", "Vicki", "Wade", "Yvonne"]
LAST = ["Brandt", "Okafor", "Lindgren", "Ramirez", "Hollis", "Whitaker", "Nguyen", "Kessler", "Dawson", "Albright", "Petrakis", "Mercer",
        "Sutton", "Hale", "Ostrowski", "Barlow", "Iverson", "Castillo", "Fenwick", "Gallagher", "Haddad", "Jansen", "Kowalski", "Lambert",
        "Mendez", "Novak", "Pruitt", "Quarles", "Rhodes", "Schroeder", "Tolliver", "Underwood", "Voss", "Wexler", "Yoder", "Zimmerman"]
PLACES = {  # state: [(city, zip, area code)]
    "IN": [("Indianapolis", "46241", "317"), ("Lafayette", "47905", "765"), ("Kokomo", "46902", "765"), ("Fort Wayne", "46803", "260"),
           ("Elkhart", "46516", "574"), ("Columbus", "47201", "812"), ("Evansville", "47715", "812"), ("Anderson", "46013", "765"),
           ("Muncie", "47302", "765"), ("Warsaw", "46580", "574"), ("Plainfield", "46168", "317"), ("Greenwood", "46143", "317")],
    "OH": [("Columbus", "43207", "614"), ("Dayton", "45414", "937"), ("Toledo", "43612", "419"), ("Lima", "45801", "419"),
           ("Mansfield", "44903", "419"), ("Springfield", "45502", "937"), ("Marion", "43302", "740"), ("Findlay", "45840", "419"),
           ("Groveport", "43125", "614"), ("Zanesville", "43701", "740"), ("Wooster", "44691", "330"), ("Akron", "44312", "330")],
    "KY": [("Louisville", "40213", "502"), ("Lexington", "40511", "859"), ("Bowling Green", "42101", "270"), ("Elizabethtown", "42701", "270"),
           ("Owensboro", "42301", "270"), ("Shepherdsville", "40165", "502"), ("Hebron", "41048", "859"), ("Paducah", "42003", "270")],
    "MI": [("Grand Rapids", "49548", "616"), ("Holland", "49423", "616"), ("Kalamazoo", "49001", "269"), ("Muskegon", "49442", "231"),
           ("Battle Creek", "49037", "269"), ("Lansing", "48906", "517"), ("Jackson", "49201", "517"), ("Zeeland", "49464", "616")],
    "IL": [("Joliet", "60436", "815"), ("Rockford", "61109", "815"), ("Peoria", "61604", "309"), ("Kankakee", "60901", "815")],
}
STREETS = ["Industrial Parkway", "Commerce Drive", "Enterprise Boulevard", "Distribution Way", "Manufacturers Road", "Technology Drive",
           "Production Avenue", "Corporate Drive", "Logistics Lane", "Foundry Street", "Mill Road", "Factory Road"]
# industry: name, state
CUSTOMERS = {
    "food": [("Wabash Valley Foods", "IN"), ("Buckeye Snack Co-Pack", "OH"), ("Ohio Valley Bottling Works", "KY"), ("Prairie Gold Bakery Products", "IL"),
             ("Hoosier Harvest Packaging", "IN"), ("Lakeshore Frozen Foods", "MI"), ("Riverbend Dairy Cooperative", "IN"), ("Miami Valley Beverage Co.", "OH"),
             ("Bluegrass Spirits Bottling Services", "KY"), ("Kalamazoo Cereal Packers", "MI"), ("Tippecanoe Meat Processing", "IN"),
             ("Scioto Fresh Produce Packing", "OH"), ("Grand River Confections", "MI"), ("Heartland Pet Food Partners", "IN"),
             ("Sandusky Sauce & Condiment", "OH"), ("Thornapple Coffee Roasting Supply", "MI"), ("Elkhart Pretzel Company", "IN"),
             ("Licking Creek Juice Co.", "OH"), ("Muncie Popcorn Packers", "IN"), ("Kentucky Kettle Foods", "KY")],
    "auto": [("Great Lakes Stamping", "MI"), ("Kokomo Precision Components", "IN"), ("Saginaw Bay Gear Works", "MI"), ("Lansing Trim Systems", "MI"),
             ("Dayton Fastener Group", "OH"), ("Mansfield Brake Components", "OH"), ("Toledo Axle Machining", "OH"), ("Fort Wayne Wire Harness", "IN"),
             ("Battle Creek Seating Components", "MI"), ("Holland Precision Castings", "MI"), ("Lima Bracket & Stamping", "OH"),
             ("Muskegon Spring Works", "MI"), ("Marion Powertrain Machining", "OH"), ("Bowling Green Exhaust Systems", "KY"),
             ("Springfield Die Cast", "OH"), ("Anderson Steering Components", "IN"), ("Jackson Bearing Assembly", "MI"),
             ("Findlay Filter Products", "OH"), ("Richmond Hose & Coupling", "IN"), ("Georgetown Body Panels", "KY")],
    "plastics": [("Hoosier Precision Molding", "IN"), ("Lakeshore Plastics Group", "MI"), ("Akron Elastomer Products", "OH"), ("Evansville Polymer Works", "IN"),
                 ("Zanesville Container Molding", "OH"), ("Warsaw Medical Polymers", "IN"), ("Terre Haute Extrusion", "IN"), ("Marietta Rubber Goods", "OH"),
                 ("Grand Haven Blow Molding", "MI"), ("Seymour Thermoforming", "IN"), ("Chillicothe Foam Products", "OH"),
                 ("Kendallville Injection Molders", "IN"), ("Owensboro Plastic Pallets", "KY"), ("Portage Film Extruders", "MI"),
                 ("Bucyrus Seal & Gasket", "OH"), ("Ashland Vinyl Products", "KY"), ("Valparaiso Compounding", "IN"), ("Wooster Tire Components", "OH")],
    "metal": [("Kettering Precision Stamping", "OH"), ("Prairie Steel Fabricators", "IL"), ("Lafayette Ironworks", "IN"), ("Shelbyville Sheet Metal", "IN"),
              ("Paducah Weld & Fab", "KY"), ("Benton Harbor Laser Cutting", "MI"), ("Mishawaka Tube Bending", "IN"), ("Steubenville Structural Steel", "OH"),
              ("Frankfort Machine & Tool", "KY"), ("Hopkinsville Metal Products", "KY"), ("Defiance Forge Works", "OH"), ("Holland Tool & Die", "MI"),
              ("Peru Precision Machining", "IN"), ("Newark Metal Spinning", "OH"), ("Greenville Enclosures", "OH"), ("Elizabethtown Fabrication", "KY"),
              ("Traverse Machine Works", "MI"), ("Logansport Wire Forming", "IN")],
    "consumer": [("Bloomington Home Goods", "IN"), ("Queen City Household Products", "OH"), ("Lexington Candle Company", "KY"), ("Westerville Toy Works", "OH"),
                 ("Zeeland Furniture Components", "MI"), ("Goshen RV Interiors", "IN"), ("Heartland Outdoor Gear", "IN"), ("Ohio River Paper Goods", "OH"),
                 ("Copper Creek Pet Supplies", "KY"), ("Sycamore Kitchenware", "IL"), ("Bluebird Personal Care", "OH"),
                 ("Fox River Lawn & Garden Products", "IL"), ("Ludington Sporting Goods", "MI"), ("Whitewater Paint & Coatings", "IN")],
    "warehouse": [("Crossroads Fulfillment Center", "IN"), ("Midwest Parcel Hub", "OH"), ("I-70 Logistics Park Operations", "IN"), ("Ohio Valley Cold Storage", "KY"),
                  ("Grand Rapids Distribution Services", "MI"), ("Hebron Fulfillment Partners", "KY"), ("Plainfield E-Commerce Fulfillment", "IN"),
                  ("Groveport Distribution Co.", "OH"), ("Shepherdsville Logistics", "KY"), ("Joliet Freight Consolidators", "IL"),
                  ("Monroe Third-Party Logistics", "OH"), ("Whitestown Order Fulfillment", "IN"), ("Wilmington Air Cargo Handling", "OH"),
                  ("Walton Cross-Dock Services", "KY")],
    "oem": [("Bluegrass Case Packers", "KY"), ("Midwest Automation Builders", "IN"), ("Riverside Packaging Machinery", "OH"), ("Ridgecrest Conveyor Systems", "MI"),
            ("Allen County Machine Builders", "IN"), ("Indy Robotics Integrators", "IN"), ("Huron Palletizing Systems", "MI"), ("Maple City Labeling Machines", "IN"),
            ("Clermont Test Equipment", "OH"), ("Clay County Filling Systems", "IN"), ("Kentucky Assembly Automation", "KY"), ("Tri-State Inspection Systems", "OH"),
            ("Lake Michigan Wrapping Machines", "MI"), ("Heartland Weld Cells", "IN"), ("Northern Ohio Fixture & Gauge", "OH"), ("Corridor Robotics", "IN")],
}
INDUSTRY_LABEL = {"food": "Food and beverage packaging", "auto": "Automotive tier 2/3", "plastics": "Plastics and rubber", "metal": "Metal fabrication",
                  "consumer": "Consumer products", "warehouse": "Warehousing and distribution", "oem": "OEM machine builder"}
MIX = {  # product-line weights by industry
    "food": {"cobot": 22, "material": 24, "sensing": 13, "controls": 11, "motion": 8, "fluid": 7, "third": 5, "panel": 4, "repair": 2, "field": 3, "training": 1},
    "auto": {"motion": 28, "controls": 17, "sensing": 9, "fluid": 12, "repair": 8, "third": 9, "panel": 8, "material": 3, "cobot": 3, "field": 2.5, "training": .5},
    "plastics": {"material": 20, "sensing": 14, "cobot": 14, "controls": 15, "motion": 12, "fluid": 10, "third": 6, "panel": 3, "repair": 3, "field": 2.5, "training": .5},
    "metal": {"motion": 24, "fluid": 15, "controls": 14, "sensing": 9, "cobot": 10, "repair": 7, "third": 11, "panel": 5, "material": 2, "field": 2.5, "training": .5},
    "consumer": {"material": 20, "cobot": 15, "sensing": 14, "controls": 14, "motion": 14, "fluid": 8, "third": 6, "panel": 4, "repair": 2, "field": 2.5, "training": .5},
    "warehouse": {"material": 42, "sensing": 15, "controls": 11, "cobot": 12, "motion": 5, "fluid": 3, "third": 4, "panel": 3, "field": 4, "repair": 1},
    "oem": {"motion": 34, "controls": 29, "sensing": 12, "fluid": 10, "third": 8, "panel": 4, "material": 1, "cobot": 1, "repair": .5, "training": .5},
}
BRANCH = {"IN": "Indianapolis", "IL": "Indianapolis", "OH": "Columbus", "KY": "Louisville", "MI": "Grand Rapids"}
SEASON = {1: .92, 2: .95, 3: 1.05, 4: 1.02, 5: 1.04, 6: 1.03, 7: .93, 8: 1.02, 9: 1.07, 10: 1.05, 11: .98, 12: .87}
SEASON_MEAN = sum(SEASON.values()) / 12

def slug(name):
    return "".join(ch for ch in name.lower() if ch.isalnum())[:28]

customers = []
used_contacts = set()
for ind, lst in CUSTOMERS.items():
    for name, st in lst:
        city, zipc, area = R.choice(PLACES[st])
        while True:
            g, f = R.choice(FIRST), R.choice(LAST)
            if (g, f) not in used_contacts:
                used_contacts.add((g, f)); break
        customers.append({"key": "C" + str(len(customers) + 1).zfill(3), "name": name, "industry": ind, "state": st, "city": city,
                          "contact": {"given": g, "family": f}, "email": f"ap@{slug(name)}.example",
                          "phone": f"({area}) 555-01{R.randint(0, 99):02d}",
                          "address": {"line1": f"{R.randint(100, 9800)} {R.choice(STREETS)}", "city": city, "state": st, "zip": zipc}})

# Annual spend (2025 basis): heavy-tailed, with a few named anchors.
ANCHOR = {"Bluegrass Case Packers": 3.4e6, "Midwest Automation Builders": 2.9e6, "Great Lakes Stamping": 2.5e6, "Wabash Valley Foods": 2.1e6,
          "Crossroads Fulfillment Center": 1.9e6, "Kokomo Precision Components": 1.6e6, "Hoosier Precision Molding": 1.5e6,
          "Buckeye Snack Co-Pack": 1.35e6, "Lakeshore Plastics Group": 1.1e6, "Indy Robotics Integrators": 1.3e6, "Ohio Valley Cold Storage": 0.95e6,
          "Kettering Precision Stamping": 0.9e6}
raw = {}
for c in customers:
    raw[c["name"]] = ANCHOR.get(c["name"]) or R.lognormvariate(12.55, 0.85)
others = [n for n in raw if n not in ANCHOR]
target_others = 62.5e6 - sum(ANCHOR.values())
for _ in range(20):  # scale the long tail, keeping every other account below the named anchors
    scale = target_others / sum(raw[n] for n in others)
    for n in others:
        raw[n] = min(raw[n] * scale, 1.25e6)
# New accounts that started in 2026 and accounts that went quiet in 2026.
NEW_2026 = {"Georgetown Body Panels": date(2026, 2, 1), "Kentucky Kettle Foods": date(2026, 3, 1), "Corridor Robotics": date(2026, 1, 1),
            "Walton Cross-Dock Services": date(2026, 4, 1), "Wooster Tire Components": date(2026, 5, 1), "Logansport Wire Forming": date(2026, 6, 1)}
LOST_2026 = {"Bowling Green Exhaust Systems": date(2026, 3, 1), "Ashland Vinyl Products": date(2026, 5, 1), "Newark Metal Spinning": date(2026, 7, 1)}
for n in NEW_2026:
    raw[n] = max(raw[n], 140_000)
for c in customers:
    c["annual"] = raw[c["name"]]
    a = c["annual"] * (1.0 if c["name"] not in NEW_2026 else 0.75)
    c["tier"] = "A" if a > 250_000 else ("B" if a >= 50_000 else "C")
    if c["name"] in NEW_2026:
        c["tier"] = "C" if c["annual"] < 200_000 else "B"
    c["discount"] = {"A": D("0.15"), "B": D("0.10"), "C": D("0.05")}[c["tier"]]
    c["terms"] = "Net 30"
    c["branch"] = BRANCH[c["state"]]
    # Payment habit: days paid relative to the due date.
    c["pay"] = R.choices([(-4, 4), (2, 10), (8, 22), (18, 35)], weights=[52, 28, 15, 5])[0]
for n in ["Bluegrass Case Packers", "Midwest Automation Builders", "Great Lakes Stamping", "Crossroads Fulfillment Center", "Kokomo Precision Components", "Indy Robotics Integrators"]:
    next(c for c in customers if c["name"] == n)["terms"] = "Net 45"
for c in customers:
    notes = [f"Tier {c['tier']} account", f"{c['branch']} branch", INDUSTRY_LABEL[c["industry"]]]
    if c["terms"] == "Net 45":
        notes.append("Net 45 approved by Deal Desk")
    if c["name"] in NEW_2026:
        notes.append(f"New account {NEW_2026[c['name']].strftime('%B %Y')}")
    c["notes"] = "; ".join(notes)
    c["exemptionNo"] = f"ST-105 {R.randint(100000, 999999)}"
CUST = {c["name"]: c for c in customers}
# Payment stories used in demos.
CUST["Wabash Valley Foods"]["pay"] = (6, 16)
CUST["Lakeshore Plastics Group"]["pay"] = (8, 18)  # becomes slow in 2026 (below)
CUST["Kettering Precision Stamping"]["pay"] = (4, 12)

# ---------------------------------------------------------------- vendors
VENDORS = [
    # key, name, terms, kind, city, state, area
    ("V-RMM", "Ridgeway Motion Manufacturing Co.", "Net 45", "motion", "Dayton", "OH", "937"),
    ("V-KCM", "Kestrel Controls Manufacturing", "Net 45", "controls", "Schaumburg", "IL", "847"),
    ("V-NSW", "Northfield Sensor Works", "Net 30", "sensing", "Northfield", "IL", "847"),
    ("V-HPC", "Harbor Point Conveyor Fabrication", "Net 30", "material", "Holland", "MI", "616"),
    ("V-ARA", "Arclight Robotics Assembly", "Net 60", "cobot", "Ann Arbor", "MI", "734"),
    ("V-SPI", "Summit Pneumatics Inc.", "Net 30", "fluid", "Cleveland", "OH", "216"),
    ("V-GLS", "Great Lakes Industrial Sourcing", "Net 30", "third", "Toledo", "OH", "419"),
    ("V-MEW", "Midwest Enclosure & Wire Supply", "Net 30", "panel", "Indianapolis", "IN", "317"),
    ("V-PRP", "Precision Rebuild Parts Co.", "Net 30", "repair", "Fort Wayne", "IN", "260"),
    ("V-PGL", "Pacific Gateway Logistics", "Net 30", "freight-in", "Chicago", "IL", "312"),
    ("V-CFL", "Crossroads Freight Lines", "Net 15", "freight-out", "Indianapolis", "IN", "317"),
    ("V-MIP", "Meridian Industrial Properties", "Due on receipt", "rent", "Indianapolis", "IN", "317"),
    ("V-SBP", "Scioto Business Park LLC", "Due on receipt", "rent", "Columbus", "OH", "614"),
    ("V-OVC", "Ohio Valley Commerce Center", "Due on receipt", "rent", "Louisville", "KY", "502"),
    ("V-GRI", "Grand River Industrial Park", "Due on receipt", "rent", "Grand Rapids", "MI", "616"),
    ("V-MGE", "Midwest Gas & Electric", "Net 15", "utilities", "Indianapolis", "IN", "317"),
    ("V-MFC", "Midwest Fiber Communications", "Net 30", "telecom", "Carmel", "IN", "317"),
    ("V-KMI", "Keystone Mutual Commercial Insurance", "Net 30", "insurance", "Columbus", "OH", "614"),
    ("V-HBP", "Heartland Benefit Partners", "Due on receipt", "benefits", "Indianapolis", "IN", "317"),
    ("V-NIT", "Northgate IT Services", "Net 30", "it", "Fishers", "IN", "317"),
    ("V-CBS", "Cloudline Business Software", "Net 30", "software", "Chicago", "IL", "312"),
    ("V-BMG", "Brightwork Marketing Group", "Net 30", "marketing", "Indianapolis", "IN", "317"),
    ("V-LHC", "Lindqvist & Hale CPAs", "Net 30", "accounting", "Indianapolis", "IN", "317"),
    ("V-CBL", "Carrow Benton LLP", "Net 30", "legal", "Indianapolis", "IN", "317"),
    ("V-FPF", "FleetPro Fuel Card", "Net 15", "fuel", "Louisville", "KY", "502"),
    ("V-HLT", "Hoosier Lift Truck Service", "Net 30", "forklift", "Indianapolis", "IN", "317"),
    ("V-PWS", "Packwell Industrial Packaging Supplies", "Net 30", "supplies", "Columbus", "OH", "614"),
    ("V-PPS", "Pinnacle Payroll Services", "Due on receipt", "payroll", "Indianapolis", "IN", "317"),
    ("V-HCB", "Heartland Commerce Bank", "Due on receipt", "bank", "Indianapolis", "IN", "317"),
    ("V-WCT", "Waypoint Corporate Travel", "Due on receipt", "travel", "Indianapolis", "IN", "317"),
    ("V-OSC", "Officewise Supply Co.", "Due on receipt", "office", "Indianapolis", "IN", "317"),
    ("V-MDA", "Midwest Distributors Association", "Due on receipt", "dues", "Chicago", "IL", "312"),
]
vendors = []
for key, name, terms, kind, city, st, area in VENDORS:
    vendors.append({"key": key, "name": name, "terms": terms, "kind": kind,
                    "email": f"billing@{slug(name)}.example", "phone": f"({area}) 555-01{R.randint(0, 99):02d}",
                    "address": {"line1": f"{R.randint(100, 9800)} {R.choice(STREETS)}", "city": city, "state": st, "zip": ""},
                    "accountNo": f"TIS-{R.randint(10000, 99999)}"})
VEND = {v["kind"]: v for v in vendors if v["kind"] not in ("rent",)}
RENT = [v for v in vendors if v["kind"] == "rent"]
SUPPLIER_FOR = {"motion": "V-RMM", "controls": "V-KCM", "sensing": "V-NSW", "material": "V-HPC", "cobot": "V-ARA", "fluid": "V-SPI",
                "third": "V-GLS", "panel": "V-MEW", "repair": "V-PRP", "field": "V-PRP", "training": None}
VKEY = {v["key"]: v for v in vendors}

# ---------------------------------------------------------------- sales
def net_price(sku, qty, disc):
    d = disc + (D("0.03") if qty >= 10 else D(0))
    cap = D("0.12") if SKU_LINE[sku] == "cobot" else D("0.25")
    d = min(d, cap)
    return q(LIST[sku] * (1 - d)), d

def pick_sku(line):
    opts = BY_LINE[line]
    return R.choices(opts, weights=[o[4] for o in opts])[0][0]

def make_lines(cust, amount, when, n_lines):
    mix = dict(MIX[cust["industry"]])
    if when.year == 2026:
        mix["cobot"] = mix.get("cobot", 0) * 1.75
    keys = list(mix)
    chosen = []
    for _ in range(n_lines):
        chosen.append(R.choices(keys, weights=[mix[k] for k in keys])[0])
    shares = [R.uniform(0.6, 1.4) for _ in chosen]
    tot = sum(shares)
    lines = []
    for line, sh in zip(chosen, shares):
        amt = amount * sh / tot
        if line in BY_LINE:
            if line == "cobot":
                sku = "CB-10" if amt > 26000 else ("CB-5" if amt > 19000 else ("CB-PAL" if amt > 11000 else "CB-GR-E"))
            else:
                sku = pick_sku(line)
            unit, _ = net_price(sku, 1, cust["discount"])
            qty = max(1, int(round(amt / float(unit))))
            if line == "cobot":
                qty = min(qty, 4)
            if line == "material" and LIST[sku] > 1000:
                qty = min(qty, 24)
            price, d = net_price(sku, qty, cust["discount"])
            desc = SKU_DESC[sku] + (f" (list ${LIST[sku]:,.2f}, {int(d * 100)}% off)" if d else "")
            lines.append({"item": sku, "qty": qty, "rate": price, "desc": desc, "line": line})
        elif line == "panel":
            rate = q(D(max(2500, round(amt / 250) * 250)))
            lines.append({"item": "SVC-PANEL", "qty": 1, "rate": rate, "desc": "UL 508A control panel build and integration (project)", "line": line})
        elif line == "repair":
            key = R.choice(["SVC-REPAIR-MTR", "SVC-REPAIR-MTR", "SVC-REPAIR-DRV", "SVC-REPAIR-HMI"])
            lo, hi = REPAIR_RATE[key]
            rate = q(D(R.randint(lo, hi)))
            qty = max(1, int(round(amt / float(rate))))
            lines.append({"item": key, "qty": min(qty, 30), "rate": rate, "desc": dict((s[0], s[2]) for s in SERVICES)[key], "line": line})
        elif line == "field":
            hrs = max(2, int(round(amt / 165)))
            lines.append({"item": "SVC-FIELD", "qty": min(hrs, 160), "rate": D(165), "desc": "Field service technician, per hour", "line": line})
        elif line == "training":
            lines.append({"item": "SVC-TRAIN", "qty": R.choice([1, 1, 2, 3]), "rate": D(1200), "desc": "On-site training, per day (up to 8 people)", "line": line})
        elif line == "third":
            rate = q(D(max(450, round(amt, 2))))
            lines.append({"item": "3P-SOURCED", "qty": 1, "rate": rate, "desc": R.choice(THIRD_DESCS), "line": line})
    merged = {}
    for l in lines:
        k = (l["item"], l["rate"], l["desc"])
        if k in merged:
            merged[k]["qty"] += l["qty"]
        else:
            merged[k] = dict(l)
    out = []
    for l in merged.values():
        if l["item"] in LIST:  # re-price merged quantities (volume add-on)
            l["rate"], d = net_price(l["item"], l["qty"], cust["discount"])
            l["desc"] = SKU_DESC[l["item"]] + (f" (list ${LIST[l['item']]:,.2f}, {int(d * 100)}% off)" if d else "")
        l["amount"] = q(l["rate"] * l["qty"])
        out.append(l)
    return out

invoices = []
doc_no = 104200
inv_seq = 0

def add_invoice(cust, when, lines, po=None, memo=None, note=None):
    global doc_no, inv_seq
    doc_no += 1
    inv_seq += 1
    due = when + timedelta(days=TERM_DAYS[cust["terms"]])
    inv = {"key": f"I{inv_seq:05d}", "doc": str(doc_no), "customer": cust["key"], "cname": cust["name"], "date": when, "due": due,
           "terms": cust["terms"], "lines": lines, "po": po or f"{R.randint(4500100000, 4500999999)}", "memo": memo, "note": note,
           "email": cust["email"]}
    inv["total"] = sum(l["amount"] for l in lines)
    invoices.append(inv)
    return inv

GROWTH_2026 = 1.10
for (y, m) in months():
    days = month_days(y, m)
    if not days:
        continue
    full_days = len([d for d in [date(y, m, k) for k in range(1, calendar.monthrange(y, m)[1] + 1)] if d.weekday() < 5])
    frac = len(days) / full_days
    for c in customers:
        if c["name"] in NEW_2026 and date(y, m, 1) < NEW_2026[c["name"]]:
            continue
        if c["name"] in LOST_2026 and date(y, m, 1) >= LOST_2026[c["name"]]:
            continue
        base = c["annual"] / 12 * (SEASON[m] / SEASON_MEAN) * (GROWTH_2026 if y == 2026 else 1.0)
        if c["name"] in NEW_2026:
            base *= 0.75
        spend = base * R.uniform(0.7, 1.3) * frac
        n = max(0, int(round(spend / 68000 + R.uniform(-0.35, 0.35))))
        if n == 0:
            if R.random() < min(1.0, spend / 68000 * 1.6) or (c["tier"] != "C" and R.random() < 0.55):
                n = 1
            else:
                continue
        n = min(n, 4)
        cuts = sorted(R.uniform(0.25, 1) for _ in range(n))
        tot = sum(cuts)
        for cut in cuts:
            amt = spend * cut / tot
            nl = 1 if amt < 6000 else (2 if amt < 20000 else R.choice([2, 3, 3, 4, 4, 5]))
            lines = make_lines(c, amt, date(y, m, 1), nl)
            add_invoice(c, R.choice(days), lines)
    # Preventive maintenance plans renew once a year for some accounts.
    for c in customers:
        h = int(hashlib.md5(c["name"].encode()).hexdigest(), 16)
        if h % 5 == 0 and (h // 5) % 12 + 1 == m and days and not (c["name"] in NEW_2026 and date(y, m, 1) < NEW_2026[c["name"]]) and not (c["name"] in LOST_2026 and date(y, m, 1) >= LOST_2026[c["name"]]):
            plan = ["SVC-PM-ESS", "SVC-PM-STD", "SVC-PM-PREM"][h % 3]
            price = dict((s[0], s[4]) for s in SERVICES)[plan]
            nlines = 1 + (h % 3)
            add_invoice(c, R.choice(days), [{"item": plan, "qty": nlines, "rate": D(price), "amount": q(D(price) * nlines),
                                             "desc": dict((s[0], s[2]) for s in SERVICES)[plan], "line": "field"}])

# Story 1: the disputed Wabash Valley Foods palletizing and conveyor project.
w = CUST["Wabash Valley Foods"]
wl = []
for sku, qty in [("CB-10", 3), ("CB-PAL", 3), ("FC-B450-2M", 8), ("FC-DRV-90", 4), ("FC-STD", 8), ("SL-KIT-PE", 12)]:
    p, d = net_price(sku, qty, w["discount"])
    wl.append({"item": sku, "qty": qty, "rate": p, "amount": q(p * qty), "line": SKU_LINE[sku],
               "desc": SKU_DESC[sku] + (f" (list ${LIST[sku]:,.2f}, {int(d * 100)}% off)" if d else "")})
wl.append({"item": "SVC-PANEL", "qty": 1, "rate": D("24500.00"), "amount": D("24500.00"), "line": "panel", "desc": "UL 508A control panel build and integration (project) - Line 3 end-of-line cell"})
wl.append({"item": "SVC-TRAIN", "qty": 3, "rate": D(1200), "amount": D("3600.00"), "line": "training", "desc": "On-site training, per day (up to 8 people)"})
WABASH_DISPUTED = add_invoice(w, date(2026, 6, 10), wl, memo="Line 3 end-of-line palletizing cell",
                              note="Customer is holding payment until the conveyor punch list is signed off (open items: guarding on curve 2, photo-eye alignment).")

# ---------------------------------------------------------------- customer payments
payments = []
pay_seq = 0
open_partial = {}
inv_pay_date = {}
for inv in invoices:
    c = CUST[inv["cname"]]
    lo, hi = c["pay"]
    delay = R.randint(lo, hi)
    if inv is WABASH_DISPUTED:
        continue  # still unpaid
    if inv["cname"] == "Lakeshore Plastics Group" and inv["date"] >= date(2026, 5, 1):
        delay = R.randint(68, 95)  # cash-strapped this year
    if inv["cname"] == "Kettering Precision Stamping" and date(2026, 8, 1) <= inv["date"] < date(2026, 8, 20):
        delay = 48
    pd = bday(inv["due"] + timedelta(days=delay))
    if pd < inv["date"] + timedelta(days=5):
        pd = bday(inv["date"] + timedelta(days=5))
    if pd <= AS_OF:
        inv_pay_date[inv["key"]] = pd
# Short payments (pricing disputes) leave small balances open.
short = {}
for cname, month, amount in [("Ohio Valley Cold Storage", (2026, 8), D("2140.00")), ("Great Lakes Stamping", (2026, 9), D("1186.50"))]:
    cands = [i for i in invoices if i["cname"] == cname and (i["date"].year, i["date"].month) == month and i["key"] in inv_pay_date]
    if cands:
        short[cands[0]["key"]] = amount
by_cust = defaultdict(list)
for inv in invoices:
    if inv["key"] in inv_pay_date:
        by_cust[inv["customer"]].append(inv)
for ck, invs in by_cust.items():
    invs.sort(key=lambda i: inv_pay_date[i["key"]])
    group = []
    def flush():
        global pay_seq
        if not group:
            return
        pdate = max(inv_pay_date[i["key"]] for i in group)
        pay_seq += 1
        lines = [{"invoice": i["key"], "amount": i["total"] - short.get(i["key"], D(0))} for i in group]
        ref = (f"ACH {R.randint(1000000, 9999999)}" if R.random() < 0.7 else f"Check {R.randint(10000, 99999)}")
        payments.append({"key": f"P{pay_seq:05d}", "customer": ck, "date": pdate, "ref": ref, "depositTo": BANK,
                         "lines": lines, "total": sum(l["amount"] for l in lines)})
    for inv in invs:
        if group and (inv_pay_date[inv["key"]] - inv_pay_date[group[0]["key"]]).days > 6:
            flush(); group = []
        group.append(inv)
    flush()

# ---------------------------------------------------------------- bills, payroll and overhead
bills, purchases, journals = [], [], []
bseq = pseq = jseq = 0

def add_bill(vkey, when, lines, doc=None, memo=None, due=None):
    global bseq
    bseq += 1
    v = VKEY[vkey]
    b = {"key": f"B{bseq:05d}", "vendor": vkey, "vname": v["name"], "date": when, "terms": v["terms"],
         "due": due or (when + timedelta(days=TERM_DAYS[v["terms"]])), "doc": doc or f"{vkey[2:]}-{R.randint(10000, 99999)}",
         "memo": memo, "lines": lines}
    b["total"] = sum(l["amount"] for l in lines)
    bills.append(b)
    return b

def add_purchase(pay_type, account, vkey, when, lines, doc=None, memo=None):
    global pseq
    pseq += 1
    p = {"key": f"X{pseq:05d}", "payType": pay_type, "account": account, "vendor": vkey, "date": when, "doc": doc, "memo": memo, "lines": lines}
    p["total"] = sum(l["amount"] for l in lines)
    purchases.append(p)
    return p

def add_journal(when, doc, memo, lines):
    global jseq
    jseq += 1
    j = {"key": f"J{jseq:04d}", "date": when, "doc": doc, "memo": memo, "lines": lines}
    dr = sum(l["amount"] for l in lines if l["posting"] == "Debit")
    cr = sum(l["amount"] for l in lines if l["posting"] == "Credit")
    assert dr == cr, (doc, dr, cr)
    journals.append(j)

def L(account, amount, desc=None):
    return {"account": account, "amount": q(amount), "desc": desc}

sales_by_month_line = defaultdict(lambda: defaultdict(D))
for inv in invoices:
    for l in inv["lines"]:
        sales_by_month_line[(inv["date"].year, inv["date"].month)][l["line"]] += l["amount"]
sales_by_month = {k: sum(v.values()) for k, v in sales_by_month_line.items()}

LINE_TEXT = {"motion": "MotionPro servo motors, drives and cables", "controls": "ControlLine PLCs, HMIs and I/O", "sensing": "SenseLine sensors and kits",
             "material": "FlexConvey conveyor sections and drives", "cobot": "CoBot robots, grippers and palletizing kits",
             "fluid": "Pneumatic cylinders, valves and FRLs", "third": "Sourced third-party products", "panel": "Panel enclosures, wire and components",
             "repair": "Repair parts and rebuild kits", "field": "Field service parts and subcontract labor"}
card_by_month = defaultdict(D)
capex_racking = None
for (y, m) in months():
    days = month_days(y, m)
    if not days:
        continue
    mk = (y, m)
    lines_sales = sales_by_month_line.get(mk, {})
    first = bday(date(y, m, 1))
    # Supplier bills for product cost, two to four per supplier per month.
    cost_by_vendor = defaultdict(lambda: defaultdict(D))
    for line, amt in lines_sales.items():
        vk = SUPPLIER_FOR.get(line)
        if not vk:
            continue
        cost = amt * D(str(1 - MARGIN[line])) * D(str(R.uniform(0.97, 1.03)))
        acct = "Cost of Goods Sold:Service Parts & Subcontract" if line in ("panel", "repair", "field") else "Cost of Goods Sold:Product Cost"
        cost_by_vendor[vk][(line, acct)] += cost
    for vk, parts in cost_by_vendor.items():
        total = sum(parts.values())
        n = 1 if total < 60000 else (2 if total < 250000 else (3 if total < 600000 else 4))
        bill_days = sorted(R.sample(days, min(n, len(days))))
        splits = [R.uniform(0.7, 1.3) for _ in bill_days]
        st = sum(splits)
        for bd, sp in zip(bill_days, splits):
            ls = []
            for (line, acct), amt in parts.items():
                a = q(amt * D(str(sp / st)))
                if a > 0:
                    ls.append(L(acct, a, f"{LINE_TEXT[line]} - PO {R.randint(41000, 49999)}"))
            if ls:
                add_bill(vk, bd, ls)
    prod_sales = sum(v for k, v in lines_sales.items() if k in ("motion", "controls", "sensing", "material", "cobot", "fluid", "third"))
    # Inbound freight (ocean and domestic) - spiked in March 2026 with port surcharges.
    rate = 0.0135 * (1.85 if (y, m) == (2026, 3) else 1.0) * R.uniform(0.92, 1.08)
    if prod_sales:
        memo = "Includes port congestion surcharges" if (y, m) == (2026, 3) else None
        add_bill("V-PGL", days[min(len(days) - 1, 18)], [L("Cost of Goods Sold:Inbound Freight", prod_sales * D(str(rate)), f"Inbound freight, {calendar.month_name[m]} {y}")], memo=memo)
    # Outbound LTL freight, twice a month.
    out_rate = 0.0115 * R.uniform(0.93, 1.07)
    for half in (0, 1):
        d_ = days[min(len(days) - 1, 9 if half == 0 else len(days) - 1)]
        if d_ <= AS_OF and sales_by_month.get(mk):
            add_bill("V-CFL", d_, [L("Shipping & Delivery", sales_by_month[mk] * D(str(out_rate / 2)), f"Outbound LTL shipments, {'first' if half == 0 else 'second'} half of {calendar.month_name[m]}")])
    esc = 1.03 if y == 2026 else 1.0
    # Rent, due on the 1st.
    for v, amt in zip(RENT, [56500, 17800, 14200, 15400]):
        add_bill(v["key"], first, [L("Rent or Lease", D(amt) * D(str(esc)), f"{calendar.month_name[m]} rent - {v['address']['city']} {'headquarters and warehouse' if v['key'] == 'V-MIP' else 'branch'}")], doc=f"RENT-{y}{m:02d}")
    util = {1: 18400, 2: 17200, 3: 14000, 4: 11500, 5: 10800, 6: 13600, 7: 16800, 8: 16200, 9: 12900, 10: 11400, 11: 13900, 12: 17100}[m]
    if len(days) >= 6:
        add_bill("V-MGE", days[5], [L("Utilities:Gas and Electric", D(util) * D(str(R.uniform(0.94, 1.06))), "Electric and gas, all four sites")])
    add_bill("V-MFC", first, [L("Utilities:Telephone", D("4680.00"), "Fiber, phones and mobile plans")])
    add_bill("V-KMI", first, [L("Insurance", D("16200.00") * D(str(esc)), "General liability, property and auto"), L("Insurance:Workers Compensation", D("7400.00") * D(str(esc)), "Workers compensation")])
    add_bill("V-HBP", first, [L("Payroll Expenses:Employee Benefits", D(112000 if y == 2025 else 121400) * D(str(R.uniform(0.98, 1.02))), "Employee health, dental and vision premiums")])
    add_bill("V-NIT", first, [L("Software & IT", D("11200.00"), "Managed IT services")])
    add_bill("V-CBS", first, [L("Software & IT", D("13400.00") + (D("9200.00") if m == 1 else D(0)), "ERP and CRM subscriptions" + (" (annual true-up)" if m == 1 else ""))])
    mk_lines = [L("Marketing & Advertising", D("16500.00"), "Marketing retainer")]
    if m == 4:
        mk_lines.append(L("Marketing & Advertising", D(46800 if y == 2025 else 51200), "Trade show booth and travel - Midwest Automation Expo"))
    if m == 9:
        mk_lines.append(L("Marketing & Advertising", D("12000.00"), "Cobot lead-generation campaign"))
    add_bill("V-BMG", first, mk_lines)
    cpa = [L("Legal & Professional Fees:Accounting", D("7800.00"), "Monthly accounting and tax services")]
    if m == 3:
        cpa.append(L("Legal & Professional Fees:Accounting", D(38500 if y == 2025 else 40500), f"Annual financial statement audit, {y - 1}"))
    if len(days) > 10:
        add_bill("V-LHC", days[10], cpa)
    if m in (1, 4, 7, 10) and len(days) > 12:
        add_bill("V-CBL", days[12], [L("Legal & Professional Fees:Lawyer", D(R.choice([6200, 7400, 9800, 12600])), "Contracts and general counsel")])
    if len(days) > 3:
        add_bill("V-FPF", days[3], [L("Automobile:Fuel", D(R.randint(15200, 19400)), "Fleet fuel, prior month")])
    if len(days) > 14:
        add_bill("V-HLT", days[14], [L("Maintenance and Repair:Equipment Repairs", D(R.randint(6800, 9600)), "Forklift maintenance and repairs")])
        add_bill("V-PWS", days[14], [L("Supplies", D(R.randint(10200, 14200)), "Warehouse packaging and shipping supplies")])
    # Payroll: mid-month (with commissions on last month's sales) and month end.
    wages = D(812000 if y == 2025 else 838000)
    if (y, m) == (2025, 12):
        bonus = D(126000)
    else:
        bonus = D(0)
    tax_rate = D("0.082") if m <= 3 else D("0.0745")
    prev = (y, m - 1) if m > 1 else (y - 1, 12)
    commissions = q(sales_by_month.get(prev, D(0)) * D("0.0135"))
    mid = bday_back(date(y, m, 15))
    if mid <= AS_OF:
        ls = [L("Payroll Expenses:Salaries & Wages", wages / 2 * D(str(R.uniform(0.99, 1.01))), "Gross wages, first half"),
              L("Payroll Expenses:Payroll Taxes", wages / 2 * tax_rate, "Employer payroll taxes")]
        if commissions:
            ls.append(L("Payroll Expenses:Sales Commissions", commissions, f"Sales commissions on {calendar.month_name[prev[1]]} sales"))
        add_purchase("Cash", BANK, "V-PPS", mid, ls, memo=f"Payroll {mid.isoformat()}")
    end = last_bday(y, m)
    if end <= AS_OF:
        ls = [L("Payroll Expenses:Salaries & Wages", wages / 2 * D(str(R.uniform(0.99, 1.01))) + bonus, "Gross wages, second half" + (" and year-end bonuses" if bonus else "")),
              L("Payroll Expenses:Payroll Taxes", (wages / 2 + bonus) * tax_rate, "Employer payroll taxes")]
        add_purchase("Cash", BANK, "V-PPS", end, ls, memo=f"Payroll {end.isoformat()}")
    # Company card spend.
    for k in range(R.randint(5, 8)):
        d_ = R.choice(days)
        kind = R.choice(["travel", "travel", "meals", "office", "dues"])
        if kind == "travel":
            amt, vk, acct, desc = D(R.randint(1200, 3600)), "V-WCT", "Travel", "Customer visits and branch travel"
        elif kind == "meals":
            amt, vk, acct, desc = D(R.randint(350, 1400)), None, "Meals and Entertainment", "Customer meals"
        elif kind == "office":
            amt, vk, acct, desc = D(R.randint(500, 1600)), "V-OSC", "Office Expenses", "Office supplies"
        else:
            amt, vk, acct, desc = D(R.randint(150, 900)), "V-MDA", "Dues & Subscriptions", "Association dues and subscriptions"
        add_purchase("CreditCard", CARD, vk, d_, [L(acct, amt + D(R.randint(0, 99)) / 100, desc)])
        card_by_month[mk] += q(amt + D(R.randint(0, 99)) / 100) * 0  # placeholder, recomputed below
    # Bank, loan and line of credit.
    if end <= AS_OF:
        add_purchase("Cash", BANK, "V-HCB", end, [L("Bank Charges", D(R.randint(5200, 6900)), "Merchant card fees and bank service charges")])
        add_journal(end, f"DEP-{y}{m:02d}", "Monthly depreciation", [
            {"account": "Depreciation", "posting": "Debit", "amount": D("41600.00") if (y, m) < (2026, 3) else D("45600.00"), "desc": "Depreciation"},
            {"account": "Accumulated Depreciation", "posting": "Credit", "amount": D("41600.00") if (y, m) < (2026, 3) else D("45600.00"), "desc": "Depreciation"}])
    if (y, m) == (2026, 2):
        capex_racking = add_purchase("Check", BANK, "V-HLT", date(2026, 2, 19), [L("Warehouse Equipment & Racking", D("238600.00"), "Pallet racking and two electric forklifts - Indianapolis expansion")], doc="10482")

# Card purchases recomputed by month for the monthly payoff.
card_by_month = defaultdict(D)
for p in purchases:
    if p["payType"] == "CreditCard":
        card_by_month[(p["date"].year, p["date"].month)] += p["total"]

# Term loan and line of credit (amortizing equipment loan; revolver held at $2.5M).
term_balance = D("1850000.00")
mm_balance = D("1500000.00")
for (y, m) in months():
    d20 = bday(date(y, m, 20))
    if d20 <= AS_OF:
        interest = q(term_balance * D("0.0675") / 12)
        principal = D("30800.00")
        term_balance -= principal
        add_purchase("Cash", BANK, "V-HCB", d20, [L("Term Loan - Equipment", principal, "Equipment loan principal"), L("Interest Expense", interest, "Equipment loan interest")], memo="Equipment term loan payment")
    d25 = bday(date(y, m, 25))
    if d25 <= AS_OF:
        rate = D("0.0825") if y == 2025 else D("0.0775")
        loc = D("2500000.00") if (y, m) <= (2026, 3) else D("1500000.00")
        add_purchase("Cash", BANK, "V-HCB", d25, [L("Interest Expense", loc * rate / 12, "Line of credit interest")], memo="Revolving line of credit interest")
    if (y, m) == (2026, 3):
        add_journal(date(2026, 3, 31), "LOC-2603", "Line of credit paydown", [
            {"account": "Line of Credit", "posting": "Debit", "amount": D("1000000.00"), "desc": "Paydown of revolving line of credit"},
            {"account": BANK, "posting": "Credit", "amount": D("1000000.00"), "desc": "Paydown of revolving line of credit"}])
    end = last_bday(y, m)
    if end <= AS_OF:
        rate = D("0.036") if y == 2025 else D("0.033")
        intr = q(mm_balance * rate / 12)
        mm_balance += intr
        add_journal(end, f"MMI-{y}{m:02d}", "Money market interest", [
            {"account": MM, "posting": "Debit", "amount": intr, "desc": "Interest credited"},
            {"account": "Interest Income", "posting": "Credit", "amount": intr, "desc": "Interest credited"}])
    # Card paid in full on the 6th for the prior month (opening balance paid in January).
    d6 = bday(date(y, m, 6))
    prev = (y, m - 1) if m > 1 else (y - 1, 12)
    amt = card_by_month.get(prev, D(0)) if (y, m) != (2025, 1) else D("42000.00")
    if d6 <= AS_OF and amt:
        add_journal(d6, f"CC-{y}{m:02d}", "Company card payment", [
            {"account": CARD, "posting": "Debit", "amount": q(amt), "desc": "Card statement paid in full"},
            {"account": BANK, "posting": "Credit", "amount": q(amt), "desc": "Card statement paid in full"}])
for when, amt in [(date(2025, 4, 15), 380000), (date(2025, 6, 16), 380000), (date(2025, 9, 15), 380000), (date(2026, 1, 15), 380000),
                  (date(2026, 4, 15), 450000), (date(2026, 6, 15), 450000), (date(2026, 9, 15), 450000)]:
    add_journal(when, f"DIST-{when.strftime('%y%m')}", "Quarterly shareholder distribution (estimated taxes)", [
        {"account": "Shareholder Distributions", "posting": "Debit", "amount": D(amt), "desc": "Shareholder distribution"},
        {"account": BANK, "posting": "Credit", "amount": D(amt), "desc": "Shareholder distribution"}])

# ---------------------------------------------------------------- bill payments
SLOW_VENDOR = {"V-HPC": (6, 12)}  # conveyor supplier paid late this autumn
bill_pay_date = {}
for b in bills:
    lo, hi = (0, 3)
    if b["vendor"] in SLOW_VENDOR and b["date"] >= date(2026, 9, 1):
        lo, hi = SLOW_VENDOR[b["vendor"]]
    pd = bday(b["due"] + timedelta(days=R.randint(lo, hi)))
    if b["terms"] == "Due on receipt":
        pd = bday(b["date"] + timedelta(days=R.randint(0, 2)))
    if pd <= AS_OF:
        bill_pay_date[b["key"]] = pd
bill_payments = []
bp_seq = 0
check_no = 20480
groups = defaultdict(list)
for b in bills:
    if b["key"] in bill_pay_date:
        groups[(b["vendor"], bill_pay_date[b["key"]])].append(b)
for (vk, pd), bs in sorted(groups.items(), key=lambda kv: (kv[0][1], kv[0][0])):
    bp_seq += 1
    check_no += 1
    lines = [{"bill": b["key"], "amount": b["total"]} for b in bs]
    bill_payments.append({"key": f"Q{bp_seq:05d}", "vendor": vk, "date": pd, "bank": BANK, "doc": str(check_no), "lines": lines,
                          "total": sum(l["amount"] for l in lines)})

# ---------------------------------------------------------------- opening balances (Dec 31, 2024)
OPENING = {
    BANK: D("3900000.00"), MM: D("1500000.00"), "Inventory Asset": D("8650000.00"), "Prepaid Expenses": D("185000.00"),
    "Warehouse Equipment & Racking": D("1960000.00"), "Vehicles": D("685000.00"), "Computer Equipment": D("310000.00"),
    "Accumulated Depreciation": D("-1180000.00"), CARD: D("-42000.00"), "Line of Credit": D("-2500000.00"),
    "Term Loan - Equipment": D("-1850000.00"), "Common Stock": D("-500000.00"),
}

# ---------------------------------------------------------------- checks and expected figures
def acct_lines_for_sales():
    out = defaultdict(D)
    for inv in invoices:
        for l in inv["lines"]:
            out[INC[l["line"]]] += l["amount"]
    return out

pl = defaultdict(lambda: defaultdict(D))  # (y,m) -> account -> amount (income +, costs +)
for inv in invoices:
    for l in inv["lines"]:
        pl[(inv["date"].year, inv["date"].month)][INC[l["line"]]] += l["amount"]
for b in bills:
    for l in b["lines"]:
        pl[(b["date"].year, b["date"].month)][l["account"]] += l["amount"]
for p in purchases:
    for l in p["lines"]:
        pl[(p["date"].year, p["date"].month)][l["account"]] += l["amount"]
for j in journals:
    for l in j["lines"]:
        sign = 1 if l["posting"] == "Debit" else -1
        pl[(j["date"].year, j["date"].month)][l["account"]] += l["amount"] * (sign if l["account"] != "Interest Income" else -sign)

INCOME_ACCTS = set(INC.values())
COGS_ACCTS = {"Cost of Goods Sold:Product Cost", "Cost of Goods Sold:Inbound Freight", "Cost of Goods Sold:Service Parts & Subcontract"}
OTHER_INC = {"Interest Income"}
OTHER_EXP = {"Depreciation", "Interest Expense"}
BS_ACCTS = {BANK, MM, CARD, "Term Loan - Equipment", "Accumulated Depreciation", "Warehouse Equipment & Racking", "Shareholder Distributions"}

def summarize(keys):
    inc = sum(pl[k][a] for k in keys for a in pl[k] if a in INCOME_ACCTS)
    cogs = sum(pl[k][a] for k in keys for a in pl[k] if a in COGS_ACCTS)
    opex = sum(pl[k][a] for k in keys for a in pl[k] if a not in INCOME_ACCTS | COGS_ACCTS | OTHER_INC | OTHER_EXP | BS_ACCTS)
    oinc = sum(pl[k][a] for k in keys for a in pl[k] if a in OTHER_INC)
    oexp = sum(pl[k][a] for k in keys for a in pl[k] if a in OTHER_EXP)
    gp = inc - cogs
    return {"income": inc, "cogs": cogs, "gross": gp, "opex": opex, "opInc": gp - opex, "otherInc": oinc, "otherExp": oexp, "net": gp - opex + oinc - oexp}

all_months = list(months())
y25 = [k for k in all_months if k[0] == 2025]
y26 = [k for k in all_months if k[0] == 2026]

# Cash simulation for the operating account.
events = defaultdict(D)
for p in payments:
    events[p["date"]] += p["total"]
for bp in bill_payments:
    events[bp["date"]] -= bp["total"]
for p in purchases:
    if p["account"] == BANK:
        events[p["date"]] -= p["total"]
for j in journals:
    for l in j["lines"]:
        if l["account"] == BANK:
            events[j["date"]] += l["amount"] if l["posting"] == "Debit" else -l["amount"]
cash = OPENING[BANK]
low = (cash, START)
month_end_cash = {}
d_ = START
while d_ <= AS_OF:
    cash += events.get(d_, D(0))
    if cash < low[0]:
        low = (cash, d_)
    nxt = d_ + timedelta(days=1)
    if nxt.month != d_.month or nxt > AS_OF:
        month_end_cash[(d_.year, d_.month)] = cash
    d_ = nxt

open_inv = [i for i in invoices if i["key"] not in inv_pay_date or i["key"] in short]
ar_items = []
for i in invoices:
    if i["key"] not in inv_pay_date:
        ar_items.append((i, i["total"]))
    elif i["key"] in short:
        ar_items.append((i, short[i["key"]]))
ar_total = sum(a for _, a in ar_items)
aging = defaultdict(D)
for i, a in ar_items:
    past = (AS_OF - i["due"]).days
    b = "current" if past <= 0 else ("1-30" if past <= 30 else ("31-60" if past <= 60 else ("61-90" if past <= 90 else "91+")))
    aging[b] += a
open_bills = [b for b in bills if b["key"] not in bill_pay_date]
ap_total = sum(b["total"] for b in open_bills)
ap_aging = defaultdict(D)
for b in open_bills:
    past = (AS_OF - b["due"]).days
    k = "current" if past <= 0 else ("1-30" if past <= 30 else ("31-60" if past <= 60 else ("61-90" if past <= 90 else "91+")))
    ap_aging[k] += b["total"]

def fmt(x):
    return f"{x:>15,.2f}"

s25, s26 = summarize(y25), summarize(y26)
print("VERSION", VERSION)
print(f"customers {len(customers)}  vendors {len(vendors)}  items {len(ITEMS)}")
print(f"invoices {len(invoices)}  payments {len(payments)}  bills {len(bills)}  bill payments {len(bill_payments)}  purchases {len(purchases)}  journals {len(journals)}")
for label, s in [("2025", s25), ("2026 YTD", s26)]:
    print(label, {k: f"{v:,.0f}" for k, v in s.items()}, f"GM {s['gross'] / s['income']:.1%} net {s['net'] / s['income']:.1%}")
print("monthly sales:", " ".join(f"{y}-{m:02d}:{float(sales_by_month.get((y, m), 0)) / 1e6:.2f}M" for y, m in all_months))
print("month-end cash:", " ".join(f"{y}-{m:02d}:{float(v) / 1e6:.2f}" for (y, m), v in month_end_cash.items()))
print(f"lowest cash {low[0]:,.2f} on {low[1]}   cash at as-of {cash:,.2f}")
print(f"AR {ar_total:,.2f} on {len(ar_items)} invoices", {k: f"{v:,.0f}" for k, v in aging.items()})
print(f"AP {ap_total:,.2f} on {len(open_bills)} bills", {k: f"{v:,.0f}" for k, v in ap_aging.items()})
by_line = defaultdict(lambda: [D(0), D(0)])
for inv in invoices:
    for l in inv["lines"]:
        by_line[l["line"]][0 if inv["date"].year == 2025 else 1] += l["amount"]
print("sales by line 2025 / 2026YTD:", {k: f"{float(v[0]) / 1e6:.2f}/{float(v[1]) / 1e6:.2f}" for k, v in by_line.items()})
top = defaultdict(D)
for inv in invoices:
    if inv["date"].year == 2025:
        top[inv["cname"]] += inv["total"]
print("top 2025 customers:", [(n, f"{float(v) / 1e6:.2f}M") for n, v in sorted(top.items(), key=lambda kv: -kv[1])[:8]])
print("invoices per month:", round(len(invoices) / len(all_months)), " open invoices:", len(ar_items), " max invoice:", f"{max(i['total'] for i in invoices):,.2f}")
print("Wabash disputed:", WABASH_DISPUTED["doc"], f"{WABASH_DISPUTED['total']:,.2f}", WABASH_DISPUTED["date"], "due", WABASH_DISPUTED["due"])

# ---------------------------------------------------------------- write dataset
def ser(x):
    if isinstance(x, D):
        return float(x)
    if isinstance(x, date):
        return x.isoformat()
    raise TypeError(type(x))

dataset = {
    "meta": {"version": VERSION, "asOf": AS_OF.isoformat(), "note": "Fictional sample books for Tallmark Industrial Supply (Convor demo)."},
    "company": COMPANY,
    "accounts": ACCOUNTS,
    "terms": TERMS,
    "items": ITEMS,
    "customers": [{k: c[k] for k in ("key", "name", "contact", "email", "phone", "address", "terms", "notes", "exemptionNo")} for c in customers],
    "vendors": [{k: v[k] for k in ("key", "name", "email", "phone", "address", "terms", "accountNo")} for v in vendors],
    "opening": {"date": "2024-12-31", "balances": OPENING, "plugAccount": "Retained Earnings"},
    "invoices": [{"key": i["key"], "doc": i["doc"], "customer": i["customer"], "date": i["date"], "due": i["due"], "terms": i["terms"], "po": i["po"],
                  "memo": i["memo"], "note": i["note"], "email": i["email"],
                  "lines": [{"item": l["item"], "qty": l["qty"], "rate": l["rate"], "amount": l["amount"], "desc": l["desc"]} for l in i["lines"]]} for i in invoices],
    "payments": [{"key": p["key"], "customer": p["customer"], "date": p["date"], "ref": p["ref"], "depositTo": p["depositTo"], "total": p["total"],
                  "lines": p["lines"]} for p in payments],
    "bills": [{"key": b["key"], "vendor": b["vendor"], "date": b["date"], "due": b["due"], "terms": b["terms"], "doc": b["doc"], "memo": b["memo"],
               "lines": b["lines"]} for b in bills],
    "billPayments": [{"key": x["key"], "vendor": x["vendor"], "date": x["date"], "bank": x["bank"], "doc": x["doc"], "total": x["total"], "lines": x["lines"]} for x in bill_payments],
    "purchases": [{"key": p["key"], "payType": p["payType"], "account": p["account"], "vendor": p["vendor"], "date": p["date"], "doc": p["doc"], "memo": p["memo"],
                   "lines": p["lines"]} for p in purchases],
    "journals": journals,
    "expected": {
        "pl2025": s25, "pl2026ytd": s26, "cashAsOf": cash, "arTotal": ar_total, "arAging": aging, "apTotal": ap_total, "apAging": ap_aging,
        "salesByMonth": {f"{y}-{m:02d}": v for (y, m), v in sales_by_month.items()},
    },
}
if "--write" in sys.argv:
    out = json.dumps(dataset, default=ser, separators=(",", ":"))
    open(sys.argv[sys.argv.index("--write") + 1], "w").write(out)
    print("written", len(out), "bytes sha256", hashlib.sha256(out.encode()).hexdigest())
