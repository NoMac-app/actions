import SwiftUI

struct CartView: View {
    @Environment(Cart.self) private var cart

    var body: some View {
        NavigationStack {
            List {
                ForEach(Array(cart.items.enumerated()), id: \.offset) { _, product in
                    HStack {
                        Text(product.name)
                        Spacer()
                        Text(product.price)
                    }
                }
                Section {
                    Text(cart.items.count == 1 ? "1 item, \(cart.total)" : "\(cart.items.count) items, \(cart.total)").accessibilityIdentifier("count")
                    Button("Check out") {
                        cart.items.removeAll()
                        cart.ordered = true
                    }
                    .disabled(cart.items.isEmpty)
                    .accessibilityIdentifier("checkout")
                    if cart.ordered {
                        Text("Order placed").accessibilityIdentifier("ordered")
                    }
                }
            }
            .navigationTitle("Cart")
        }
    }
}
